# Multi-AI Chat: Chrome Side Panel

[English](./README.md) · [繁體中文](./README.zh-TW.md) · [日本語](./README.ja.md) · **Deutsch** · [한국어](./README.ko.md)

[Im Chrome Web Store installieren](https://chromewebstore.google.com/detail/multi-ai-chat/nomhpmmhkmolkmpkjfeainjoifkipdah) · [Offizielle Website](https://ted-h-com.github.io/multi-ai-chat/?lang=de) · [Release v0.4.1](https://github.com/TED-H-com/multi-ai-chat/releases/tag/v0.4.1) · [Desktop-Version](https://ted-h-com.github.io/multi-ai-chat-desktop/?lang=de)

Einmal fragen, vier KIs gemeinsam einsetzen. Multi-AI Chat ist ein leichtes Chrome Side Panel, das deine angemeldeten **ChatGPT-, Claude-, Gemini- und Grok-Tabs** koordiniert. Es verwendet die Provider-Seiten, auf die du bereits Zugriff hast, ohne Modell-API-Schlüssel und ohne separaten Chat-Server.

**Aktuelle Version: v0.4.1** · Chrome 114+ · Manifest V3 · Fünf Oberflächensprachen · MIT

> Multi-AI Chat automatisiert Weboberflächen Dritter. Eine Änderung beim Provider kann Seiten-Selektoren vorübergehend unbrauchbar machen. Automatisierte Nutzung kann außerdem den jeweiligen Nutzungsbedingungen unterliegen. Verwende nur Konten und Inhalte, zu deren Nutzung du berechtigt bist.

![Multi-AI Chat führt in Chrome einen Workflow mit mehreren Providern aus](./store/screenshot-1280x800.png)

**v0.4.1 enthält Meta AI als experimentellen Standby-Anbieter, standardmäßig aus.** Standardmäßig bleiben die bisherigen vier Anbieter aktiv. Unter **Einstellungen → Inaktiver Anbieter** lässt sich einer davon durch Meta AI ersetzen; immer bleiben genau vier aktiv. Beim Aktivieren von Meta wird der Zugriff auf meta.ai angefragt; lehnst du ab, bleibt Meta inaktiv. Ziele und Rollen werden angepasst, die Auswahl bleibt nach Neustarts erhalten und vorhandene Tabs sowie Anmeldungen bleiben bestehen. Metas Gastzugang hängt von Website und Region ab. Deaktivierte Eingabefelder gelten nicht als bereit.

## Änderungen in v0.4.1

- Neue Chats behalten Modus und Rollen. Übergaben, Wiederherstellung und vollständige Code-Ausgabe in Coding und Rundtisch wurden korrigiert.
- Verbesserte Eingabe- und Antworterkennung schützt Entwürfe und bereits gesendete Anfragen. Senderprüfung, effizientere Speicherung und Sicherheitsupdates für Build-Abhängigkeiten sind enthalten.
- Das vollständige Ablaufprotokoll unterstützt fünf Sprachen und Tastaturbedienung. Produktionsdateien werden in isolierten Browser-Fixtures geprüft. Angemeldete Coding-/Rundtisch-Workflows wurden mit diesem Build noch nicht live geprüft; Meta bleibt experimentell und standardmäßig aus. [Versionshinweise](./store/RELEASE-v0.4.1.md).

## Die passende Version wählen

| Version | Geeignet für |
|---|---|
| **Browser-Erweiterung (dieses Repository)** | Ein kleines Chrome Side Panel für die Provider-Tabs, die du ohnehin verwendest |
| [Multi-AI Chat Desktop](https://ted-h-com.github.io/multi-ai-chat-desktop/?lang=de) | Getrennte Provider-Profile, fokussierte Live-WebViews, Snapshots, Replay, Checkpoints und Workflows mit lokalen Dateien |

Beide Versionen verwenden die Web-Sitzungen der Provider und benötigen keine Modell-API-Schlüssel.

## Highlights

- Eine Frage an ChatGPT, Claude, Gemini und Grok; der Bereitschaftsstatus jedes Providers ist vor dem Start sichtbar.
- Request-IDs isolieren verspätete Antworten. Stop bricht aktive Wartevorgänge ab und fordert die Provider-Seiten auf, die Generierung zu beenden.
- Bis zu 30 Gespräche werden lokal gespeichert, mit sicherer Markdown-Darstellung, Anschlussfragen und „Neuer Chat“.
- Oberfläche auf Englisch, traditionellem Chinesisch, Japanisch, Deutsch und Koreanisch.
- Helle, dunkle oder systemabhängige Darstellung mit WCAG-geprüftem Kontrast.
- Optionale Veröffentlichung auf HackMD mit dem eigenen Token, nur nach ausdrücklicher Auswahl.

## Modi und Wiederherstellung

| Modus | Ablauf |
|---|---|
| **Frei** | Parallel an alle ausgewählten und bereiten Provider senden |
| **Debatte** | Pro → Contra → Urteil → Synthese |
| **Beratung** | Zwei unabhängige Antworten → Prüfung → Endergebnis |
| **Coding** | Acht Schritte für Spezifikation, Review, Umsetzung, Tests, Überarbeitung und Abnahme |
| **Rundtisch** | Fünf Runden × vier KIs = zwanzig Beiträge |

Fällt ein Provider während des Rundtischs aus, pausiert der Workflow und bietet **Erneut versuchen**, **Beitrag überspringen** oder **Abbrechen** an. Ein Retry erhält eine neue Request-ID. Beim Überspringen wird nur im verbleibenden Rundtisch-Kontext ein sicherer Platzhalter eingesetzt. So gelangen weder Provider-Fehlertexte noch veraltete Antworten ins Transkript oder in spätere Beiträge.

## Installation

### Chrome Web Store (empfohlen)

[Installiere Multi-AI Chat aus dem Chrome Web Store](https://chromewebstore.google.com/detail/multi-ai-chat/nomhpmmhkmolkmpkjfeainjoifkipdah). Chrome installiert freigegebene Updates automatisch; für die normale Nutzung ist dies die beste Option.

Der Eintrag im Chrome Web Store ist **v0.3.0** (aktualisiert am 2026-09-23) und enthält Meta AI als experimentellen Standby. Chrome rollt Updates schrittweise aus, daher hat ein bestimmter Nutzer v0.3.0 möglicherweise noch nicht.

### Manuelle oder Entwickler-Installation

Die ZIP-Datei aus GitHub Releases dient als manuelle Alternative und kann direkt als entpackte Erweiterung geladen werden; ein Build aus dem Quellcode ist nicht erforderlich.

> v0.4.1 ist auf GitHub verfügbar. ZIP und Prüfsumme unten sind die offiziellen Release-Dateien. Die Veröffentlichung im Chrome Web Store folgt einem separaten Einreichungs- und Prüfverfahren.

1. Lade [`multi-ai-chat-store-v0.4.1.zip`](https://github.com/TED-H-com/multi-ai-chat/releases/download/v0.4.1/multi-ai-chat-store-v0.4.1.zip) und die zugehörige [Prüfsummendatei](https://github.com/TED-H-com/multi-ai-chat/releases/download/v0.4.1/multi-ai-chat-store-v0.4.1.zip.sha256) herunter.
2. Prüfe das Archiv. Die erwartete SHA-256-Prüfsumme lautet `4255487cbcdd08c9028ddf3079bc5851b951ed124e10b695d8981144e5606edc`.

   ```powershell
   (Get-FileHash .\multi-ai-chat-store-v0.4.1.zip -Algorithm SHA256).Hash.ToLower()
   ```

   ```sh
   shasum -a 256 multi-ai-chat-store-v0.4.1.zip
   ```

3. Entpacke die ZIP-Datei in einen dauerhaften Ordner. Direkt darin befindet sich `manifest.json`.
4. Öffne `chrome://extensions`, aktiviere den **Entwicklermodus**, wähle **Entpackte Erweiterung laden** und gib den entpackten Ordner an.
5. Hefte **Multi-AI Chat** an und öffne über das Symbol das Side Panel. Öffne anschließend jeden Provider einmal und melde dich an. Sobald der Composer erkannt wurde, zeigt der Provider „**Bereit**“ an.

Für ein Update entpackst du das neue Release in einen eigenen dauerhaften Ordner und stellst die geladene Erweiterung auf diesen Ordner um. Entferne den alten Ordner erst, wenn die neue Version funktioniert.

### Aus dem Quellcode bauen

Voraussetzungen: Chrome 114+, Node.js 22.18+, npm und Git.

```sh
git clone https://github.com/TED-H-com/multi-ai-chat.git
cd multi-ai-chat
npm ci
npm run verify
```

Lade anschließend den erzeugten Ordner `dist/` über `chrome://extensions`. Während der Entwicklung startest du `npm run dev`, lädst die Erweiterung dort neu und öffnest das Side Panel erneut.

## Verwendung

1. Wähle eine Workflow-Karte.
2. Im freien Modus bleiben alle vier Provider ausgewählt; nicht benötigte Provider kannst du abwählen.
3. Klappe **KI-Verbindungen** auf und öffne fehlende Provider oder melde dich an.
4. Gib eine Frage ein und drücke Enter oder **Senden**.
5. Verfolge den Workflow-Status; mit **Stopp** kannst du jederzeit abbrechen.
6. Stelle nach Abschluss weitere Fragen oder starte über das Menü einen **Neuen Chat**.

Lass das Side Panel geöffnet, solange ein serieller Workflow läuft.

## Bekannte Einschränkung

- **Microsoft Edge + Claude:** Edge kann die Ausführung der Erweiterung auf `claude.ai` blockieren. Die Claude-Karte bleibt dann bei „Öffnen“, das Symbol zeigt „Diese Erweiterung ist auf dieser Website nicht zulässig“, und der Websitezugriff lässt sich nicht freigeben. ChatGPT, Gemini und Grok sind nicht betroffen. Derselbe Build funktioniert in Google Chrome; Chrome ist daher die aktuelle Problemumgehung für Claude.

## Berechtigungen und Datenschutz

| Zugriff | Warum er benötigt wird |
|---|---|
| `sidePanel` | Zeigt die gesamte Bedienoberfläche an |
| `tabs` | Findet und fokussiert Provider-Tabs und verfolgt Laden, Navigation, Neuladen und Schließen; Inhalte anderer Tabs werden nicht gelesen |
| `scripting` | Injiziert ausschließlich die mitgelieferten Content Scripts erneut, wenn ein Provider-Tab schon vor dem Neuladen der Erweiterung geöffnet war oder sein Script entfernt wurde; Remote-Code wird nie ausgeführt |
| `storage` | Speichert Oberflächeneinstellungen, bis zu 30 lokale Gespräche und einen optionalen HackMD-Token auf deinem Gerät |
| Provider-Hosts | Gibt auf `chatgpt.com`, `chat.openai.com`, `claude.ai`, `gemini.google.com` und `grok.com` Prompts ein, sendet sie und liest die sichtbaren Antworten für den gewählten Workflow |
| `api.hackmd.io` | Wird nur kontaktiert, nachdem du ausdrücklich **Veröffentlichen** gewählt hast, um mit deinem Token eine für Gäste lesbare Notiz anzulegen |

Prompts gehen direkt an die von dir ausgewählten Provider-Seiten. Es gibt **keinen Multi-AI-Chat-Server, keine Analyse, kein Tracking, keine Werbung, keine Telemetrie und keine Modell-API-Zugangsdaten**. Der optionale HackMD-Token ist auf vertrauenswürdige Erweiterungskontexte beschränkt und kann von Provider-Content-Scripts nicht gelesen werden. Lokale Daten bleiben in Chrome, bis du sie löschst oder die Erweiterung entfernst; beim Entfernen wird ihr lokaler Speicher gelöscht. Für Inhalte, die du selbst versendest, gelten weiterhin die Datenschutzrichtlinien der Provider und von HackMD.

Lies die vollständige [Datenschutzrichtlinie](./store/PRIVACY.md).

## Entwicklung

```sh
npm run typecheck
npm run test
npm run build
npm run verify
npm audit
```

Wichtige Module:

- `src/background/service-worker.ts`: Workflow-Steuerung, Request-Isolation, Abbruch und Tab-Wiederherstellung
- `src/content/base.ts`: geprüfte Eingabe-, Sende- und Antwortlogik
- `src/content/*.ts`: Provider-spezifische Selektoren und Editor-Strategien
- `src/sidepanel/`: React-Oberfläche, lokale Sitzungen, Markdown, Themes und Lokalisierung

Führe vor einem Pull Request `npm run verify` aus. Wenn eine Provider-Seite nicht mehr funktioniert, erstelle ein [Issue](https://github.com/TED-H-com/multi-ai-chat/issues) mit Provider und Browser-Version. Entferne zuvor Prompts, Antworten, Kontodaten und Tokens aus Screenshots oder Logs.

## Projekt und Danksagung

- [Offizielle Website](https://ted-h-com.github.io/multi-ai-chat/?lang=de)
- [GitHub Releases](https://github.com/TED-H-com/multi-ai-chat/releases)
- [Quellcode und Issue-Tracker](https://github.com/TED-H-com/multi-ai-chat)
- [Multi-AI Chat Desktop](https://ted-h-com.github.io/multi-ai-chat-desktop/?lang=de)
- [MIT-Lizenz](./LICENSE)

Gesponsert von [AI-Sister.com](https://ai-sister.com). Erstellt von Ted Huang ([TED@TED-H.com](mailto:TED@TED-H.com), [ted-h.com](https://ted-h.com)).

Besonderer Dank gilt [@DaveTseng2019](https://github.com/DaveTseng2019) für umfangreiche Beiträge zu v0.2.x: Zuverlässigkeit beim Senden und Empfangen, Verbindungswiederherstellung, lokalisierte Fehlerbehandlung, Dark Mode, Side-Panel-UX, das transparente Symbol und die Projektlizenz.
