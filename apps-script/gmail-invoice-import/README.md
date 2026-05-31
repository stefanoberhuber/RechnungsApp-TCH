# Gmail-Rechnungsimport

Dieses Google Apps Script ist fuer das Postfach `rechnungen.tennishopfgarten@gmail.com` gedacht. Es verarbeitet neue Mails mit PDF-Anhang, legt die PDFs im bestehenden Google-Drive-Ordner ab, liest die Rechnungsdaten mit Gemini aus und schreibt je PDF eine Zeile in das bestehende Tabellenblatt `Rechnungen`.

## Einrichtung

1. Melde dich mit `rechnungen.tennishopfgarten@gmail.com` an.
2. Teile das bestehende Google Sheet und den Drive-Ordner mit diesem Konto mit Bearbeitungsrechten.
3. Oeffne [Google Apps Script](https://script.google.com/) und erstelle ein neues Projekt.
4. Kopiere den Inhalt aus `Code.gs` in die Datei `Code.gs` des Projekts.
5. Optional: Oeffne in Apps Script die Projekteinstellungen, aktiviere `appsscript.json` im Editor und ersetze den Manifest-Inhalt mit `appsscript.json` aus diesem Ordner.
6. Waehle die Funktion `processInvoiceInbox` aus und starte sie einmal manuell.
7. Bestaetige die angeforderten Google-Berechtigungen.
8. Erstelle danach einen zeitgesteuerten Trigger fuer `processInvoiceInbox`, z.B. alle 5 Minuten.

## Verhalten

- Gesucht wird mit: `has:attachment filename:pdf -label:TCH-Verarbeitet -label:TCH-Fehler`.
- Erfolgreich verarbeitete Threads erhalten automatisch das Gmail-Label `TCH-Verarbeitet`.
- Fehlerhafte Threads erhalten automatisch das Gmail-Label `TCH-Fehler`.
- Pro PDF wird eine Rechnung angelegt.
- Die Rechnungs-ID beginnt mit `MAIL-` und wird aus Message-ID, Dateiname, Dateigroesse und PDF-Hash gebildet.
- Bereits vorhandene IDs in Spalte A werden uebersprungen, damit ein erneuter Scriptlauf keine Duplikate erzeugt.

## Geschriebene Sheet-Spalten

Das Script schreibt in `Rechnungen!A:L`:

| Spalte | Wert |
| --- | --- |
| A | Rechnungs-ID / Fingerprint |
| B | Rechnungsdatum |
| C | Lieferant |
| D | Betrag |
| E | Kategorie |
| F | Rechnungsnummer |
| G | leer |
| H | `Erfasst` |
| I | Notiz |
| J | `Mailimport` |
| K | Drive-Link zur PDF |
| L | `Banküberweisung` |

## Erster Test

1. Sende eine echte Testmail mit einer PDF-Rechnung an `rechnungen.tennishopfgarten@gmail.com`.
2. Starte `processInvoiceInbox` manuell.
3. Pruefe, ob die PDF im Drive-Ordner liegt.
4. Pruefe, ob eine neue Zeile in `Rechnungen` steht.
5. Oeffne die bestehende Web-App und pruefe, ob die Rechnung sichtbar ist.
6. Starte das Script erneut. Es darf keine zweite Zeile fuer dieselbe PDF entstehen.

## Fehlerpruefung

Wenn etwas fehlschlaegt:

- Gmail-Thread hat Label `TCH-Fehler`.
- Im Spreadsheet entsteht oder erweitert sich das Blatt `Mailimport_Log`.
- Nach Korrektur kann das Label `TCH-Fehler` im Gmail-Thread entfernt werden; dann versucht der Trigger den Import erneut.
