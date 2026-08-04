# Vitality Sync — die iOS-Begleit-App

Liest Apple Health und schiebt die Werte an `/api/health` des Dashboards.

**Bundle-ID:** `ch.schmid.vitality.sync` · **Mindest-iOS:** 17.0

## Warum es diese App gibt

HealthKit hat keine Cloud-Schnittstelle. Die Daten liegen verschlüsselt auf dem
iPhone, und Apple lässt bewusst niemanden von aussen abfragen — kein Endpunkt,
kein OAuth, kein Server. Ein Pull existiert nicht. Also muss das Telefon selbst
schieben, und dafür braucht es etwas, das auf dem Telefon läuft.

Ein Kurzbefehl könnte das auch, aber nur nach Zeitplan und nur für eine Handvoll
Werte. Diese App nutzt `HKObserverQuery` mit Background Delivery: iOS weckt sie,
**sobald** Health neue Daten bekommt. Das ist der einzige Weg zu echtem „live" —
und der einzige Grund, warum es die App überhaupt gibt.

Fitbit und Yazio brauchen keine eigene Anbindung. Beide schreiben nach Apple
Health, also kommen sie hier als gewöhnliche Messwerte an.

## Die App weiss nichts

Welche Werte gelesen werden, steht **nicht** in dieser App, sondern in
`lib/server/healthMetrics.ts` des Dashboards. Beim Start holt die App
`GET /api/health/config` und sammelt, was zurückkommt.

Der Grund ist der Aufwandsunterschied: eine Web-Änderung ist ein `git push` und
zwei Minuten später live. Eine App-Änderung ist Xcode, neu signieren, neu
installieren. **Alles, was in der App landet, wird teuer in der Pflege** — also
gehört möglichst wenig hinein.

Eine neue Metrik nachrüsten heisst deshalb: eine Zeile in `healthMetrics.ts`,
deployen, fertig. Die App merkt es beim nächsten Start und fragt iOS selbst nach
der zusätzlichen Berechtigung.

## Aufbau

| Datei | Rolle |
|---|---|
| `VitalitySyncApp.swift` | Einstieg; fordert Rechte an, startet die Beobachter |
| `HealthSync.swift` | Config holen, HealthKit abfragen, senden |
| `AppConfig.swift` | Adresse in UserDefaults, Token im Schlüsselbund |
| `ContentView.swift` | Ein Statusbildschirm, mehr nicht |

Kein Diagramm, keine Historie, keine Eingabefelder — das alles zeigt das
Dashboard. Diese App beweist nur, dass die Leitung lebt, und benennt den Fehler,
wenn nicht.

## Einrichten

1. `open ios/VitalitySync.xcodeproj`
2. Target → Signing & Capabilities → dein Team wählen
3. iPhone anschliessen, als Ziel wählen, ausführen
4. In der App Adresse und Token eintragen:
   - Adresse: `https://vitality-base-chi.vercel.app`
   - Token: der Wert von `HEALTH_TOKEN` aus `.env.local`
5. Health-Berechtigungen erlauben

Danach läuft es von selbst. „Jetzt abgleichen" ist nur für den Test da.

> [!] Das Token steht bewusst **nicht** im Quellcode — es würde sonst im Repo
> landen. Es wird einmal eingetippt und liegt danach im Schlüsselbund,
> verschlüsselt und nur bei entsperrtem Gerät lesbar.

Mit bezahltem Developer-Konto läuft die Installation ein Jahr, danach neu
signieren.

## Bauen ohne Xcode-Oberfläche

```
cd ios && xcodebuild -project VitalitySync.xcodeproj -scheme VitalitySync \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```

Prüft, ob alles kompiliert — ohne Gerät und ohne Signatur.

## Trennung vom Web-Projekt

`ios/` steht in `.vercelignore`, ist aus `tsconfig.json` ausgeschlossen, und
Xcode-Buildartefakte sowie `xcuserdata/` sind gitignored. Der Next-Build fasst
diesen Ordner nicht an.

## Bekannte Grenzen

- **Trainingsdaten** kommen hier nicht an. HealthKit kennt „Krafttraining, 47
  Minuten", aber keine Sätze und Gewichte — das Train-Tile bleibt Handarbeit.
- **Schlafphasen** hängen am Gerät. Ohne Uhr am Handgelenk gibt es keinen Tief-
  oder REM-Anteil, dann bleiben `sleepDeep` und `sleepRem` leer.
- **Background Delivery** ist beste Absicht, keine Garantie. iOS entscheidet,
  wann es die App weckt. Bei ausgeschaltetem Telefon kommt die Zeile später.
