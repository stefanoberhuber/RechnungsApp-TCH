const CONFIG = {
  spreadsheetId: '157wugS72dO9AScYIPewb8ye1fj-jrV_9CjmnIR7BJ1Y',
  driveFolderId: '1GIZTNjUts9jLASOn1AOlOAszxij7ORfL',
  processedLabelName: 'TCH-Verarbeitet',
  errorLabelName: 'TCH-Fehler',
  geminiModel: 'gemini-3.1-flash-lite',
  maxThreadsPerRun: 10,
  searchQuery: 'has:attachment filename:pdf -label:TCH-Verarbeitet -label:TCH-Fehler'
};

const CATEGORIES = [
  'Getränke (Brauunion, Kaffee)',
  'Kantine',
  'Mitglieder',
  'Instandhaltung',
  'Betriebskosten',
  'Versicherungen',
  'Material (Tennisbälle etc.)',
  'Gebühren (Lizenzen)',
  'Tennislehrer',
  'Reinigung',
  'Öffentlichkeitsarbeit',
  'Miete',
  'Bankgebühren, Bankzinsen und Geldspesen',
  'Sonstiges'
];

function processInvoiceInbox() {
  const spreadsheet = SpreadsheetApp.openById(CONFIG.spreadsheetId);
  const invoiceSheet = spreadsheet.getSheetByName('Rechnungen');
  if (!invoiceSheet) throw new Error('Sheet "Rechnungen" wurde nicht gefunden.');

  const geminiKey = getGeminiApiKey_(spreadsheet);
  const processedLabel = getOrCreateLabel_(CONFIG.processedLabelName);
  const errorLabel = getOrCreateLabel_(CONFIG.errorLabelName);
  const existingIds = loadExistingInvoiceIds_(invoiceSheet);
  const threads = GmailApp.search(CONFIG.searchQuery, 0, CONFIG.maxThreadsPerRun);

  threads.forEach(thread => {
    try {
      const result = processThread_(thread, invoiceSheet, existingIds, geminiKey);
      if (result.imported > 0 || result.duplicates > 0) {
        thread.addLabel(processedLabel);
        thread.removeLabel(errorLabel);
      }
    } catch (error) {
      thread.addLabel(errorLabel);
      logImportError_(spreadsheet, thread, error);
    }
  });
}

function processThread_(thread, invoiceSheet, existingIds, geminiKey) {
  const messages = thread.getMessages();
  let imported = 0;
  let duplicates = 0;

  messages.forEach(message => {
    const attachments = message.getAttachments({ includeInlineImages: false, includeAttachments: true });
    attachments.forEach(attachment => {
      if (!isPdfAttachment_(attachment)) return;

      const fingerprint = createAttachmentFingerprint_(message, attachment);
      if (existingIds.has(fingerprint)) {
        duplicates++;
        return;
      }

      const file = uploadPdfToDrive_(attachment, fingerprint);
      const extracted = extractInvoiceData_(attachment, geminiKey);
      appendInvoiceRow_(invoiceSheet, fingerprint, extracted, file.getUrl());
      existingIds.add(fingerprint);
      imported++;
    });
  });

  return { imported, duplicates };
}

function getGeminiApiKey_(spreadsheet) {
  const configSheet = spreadsheet.getSheetByName('Konfiguration');
  if (!configSheet) throw new Error('Sheet "Konfiguration" wurde nicht gefunden.');

  const key = String(configSheet.getRange('B1').getValue() || '').trim();
  if (!key) throw new Error('Gemini API Key fehlt in Konfiguration!B1.');
  return key;
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function loadExistingInvoiceIds_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return new Set();

  const values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  return new Set(values.map(row => String(row[0] || '').trim()).filter(Boolean));
}

function isPdfAttachment_(attachment) {
  const name = String(attachment.getName() || '').toLowerCase();
  const contentType = String(attachment.getContentType() || '').toLowerCase();
  return contentType === 'application/pdf' || name.endsWith('.pdf');
}

function createAttachmentFingerprint_(message, attachment) {
  const bytes = attachment.getBytes();
  const contentHash = toHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes));
  const raw = [
    message.getId(),
    attachment.getName(),
    bytes.length,
    contentHash
  ].join('|');
  const idHash = toHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw));
  return 'MAIL-' + idHash.substring(0, 24).toUpperCase();
}

function uploadPdfToDrive_(attachment, fingerprint) {
  const folder = DriveApp.getFolderById(CONFIG.driveFolderId);
  const originalName = sanitizeFileName_(attachment.getName() || 'rechnung.pdf');
  const targetName = fingerprint + '_' + originalName;
  return folder.createFile(attachment.copyBlob()).setName(targetName);
}

function extractInvoiceData_(pdfBlob, geminiKey) {
  const prompt = 'Analysiere diese PDF-Rechnung für einen österreichischen Tennisverein. ' +
    'Gib exakt ein JSON-Objekt zurück, kein Array und keinen Markdown-Text. ' +
    'Keys: lieferant (String), datum (YYYY-MM-DD), betrag (Zahl mit Punkt), rechnr (String), ' +
    'notiz (sehr kurz), kategorie (exakt eine dieser Kategorien: ' + CATEGORIES.join(', ') + '; sonst Sonstiges).';

  const payload = {
    contents: [{
      parts: [
        { text: prompt },
        {
          inline_data: {
            mime_type: 'application/pdf',
            data: Utilities.base64Encode(pdfBlob.getBytes())
          }
        }
      ]
    }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json'
    }
  };

  const response = UrlFetchApp.fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + CONFIG.geminiModel + ':generateContent?key=' + encodeURIComponent(geminiKey),
    {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    }
  );

  const status = response.getResponseCode();
  const body = response.getContentText();
  if (status < 200 || status >= 300) {
    throw new Error('Gemini Fehler ' + status + ': ' + body.substring(0, 500));
  }

  const data = JSON.parse(body);
  const text = data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
    data.candidates[0].content.parts[0].text;
  if (!text) throw new Error('Gemini Antwort enthält keinen auslesbaren Text.');

  const parsed = extractJson_(text);
  return normalizeInvoiceData_(parsed);
}

function appendInvoiceRow_(sheet, id, invoice, fileUrl) {
  sheet.appendRow([
    id,
    invoice.datum,
    invoice.lieferant,
    formatAmountForSheet_(invoice.betrag),
    invoice.kategorie,
    invoice.rechnr,
    '',
    'Erfasst',
    invoice.notiz,
    'Mailimport',
    fileUrl,
    'Banküberweisung'
  ]);
}

function normalizeInvoiceData_(data) {
  const normalized = data || {};
  return {
    lieferant: String(normalized.lieferant || '').trim() || 'Unbekannt',
    datum: normalizeDate_(normalized.datum),
    betrag: normalizeAmount_(normalized.betrag),
    rechnr: String(normalized.rechnr || '').trim() || 'ohne Rechnungsnr.',
    notiz: String(normalized.notiz || '').trim().substring(0, 120),
    kategorie: normalizeCategory_(normalized.kategorie)
  };
}

function normalizeCategory_(value) {
  const raw = String(value || '').trim().toLowerCase();
  const match = CATEGORIES.find(category => category.toLowerCase() === raw);
  return match || 'Sonstiges';
}

function normalizeDate_(value) {
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const dotMatch = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (dotMatch) {
    return dotMatch[3] + '-' + pad2_(dotMatch[2]) + '-' + pad2_(dotMatch[1]);
  }

  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function normalizeAmount_(value) {
  const raw = String(value || '0').trim();
  const normalized = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw;
  const amount = parseFloat(normalized);
  return isNaN(amount) ? 0 : amount;
}

function formatAmountForSheet_(amount) {
  return Number(amount || 0).toFixed(2).replace('.', ',');
}

function extractJson_(text) {
  const cleaned = String(text || '').replace(/```json/g, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('Kein JSON-Objekt in Gemini Antwort gefunden: ' + cleaned.substring(0, 300));
  }
  return JSON.parse(cleaned.substring(start, end + 1));
}

function sanitizeFileName_(name) {
  return String(name || 'rechnung.pdf').replace(/[\\/:*?"<>|]/g, '_').substring(0, 120);
}

function toHex_(bytes) {
  return bytes.map(byte => {
    const unsigned = byte < 0 ? byte + 256 : byte;
    return ('0' + unsigned.toString(16)).slice(-2);
  }).join('');
}

function pad2_(value) {
  return ('0' + value).slice(-2);
}

function logImportError_(spreadsheet, thread, error) {
  const sheet = getOrCreateSheet_(spreadsheet, 'Mailimport_Log', [
    'Zeitpunkt', 'ThreadId', 'Betreff', 'Fehler'
  ]);

  const firstMessage = thread.getMessages()[0];
  sheet.appendRow([
    new Date(),
    thread.getId(),
    firstMessage ? firstMessage.getSubject() : '',
    error && error.stack ? error.stack : String(error)
  ]);
}

function getOrCreateSheet_(spreadsheet, name, header) {
  let sheet = spreadsheet.getSheetByName(name);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(name);
    sheet.appendRow(header);
  }
  return sheet;
}
