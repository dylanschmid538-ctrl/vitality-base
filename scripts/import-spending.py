#!/usr/bin/env python3
"""Raiffeisen-Transaktionsexport -> Monatssummen pro Kategorie.

Liest den xlsx-Export aus dem Finanzassistenten (Reiter "Transaktionen") und
gibt JSON auf stdout aus, das direkt in den `finance`-Slot des Dashboards passt:

    {"spending": {"2026-07": {"Lebensmittel": 480.2, ...}, ...},
     "spendingUpdated": "2026-08-02"}

Warum ein Skript und kein LLM: das hier sind Geldbeträge. Ein Modell, das 632
Zahlen abtippt, vertippt sich irgendwann, und niemand merkt es. Ein Parser
entweder funktioniert oder faellt auf die Nase.

Warum eigene Regeln statt Raiffeisens Kategorien: die Bank verbucht
MIGROS BAHNHOF LUZERN als "Oeffentlicher Verkehr" — 76% dieser Kategorie waren
in Wahrheit Lebensmittel. Die Kategorie der Bank wird deshalb ignoriert.

Absichtlich ohne Abhaengigkeiten: xlsx ist ein ZIP voller XML, das kann die
Standardbibliothek. Kein openpyxl, kein pandas.

    python3 scripts/import-spending.py ~/Downloads/Finanzassistent-*.xlsx
    python3 scripts/import-spending.py --selftest
"""

import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from collections import defaultdict
from datetime import date, timedelta

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
EXCEL_EPOCH = date(1899, 12, 30)

# ── Die Regeln ───────────────────────────────────────────────────────────────
# Reihenfolge entscheidet: die ERSTE passende Regel gewinnt. Darum stehen die
# spezifischen oben — "COOP PRONTO" vor "COOP" waere hier zwar egal (beides
# Lebensmittel), aber die Sortierung ist die Stelle, an der du das steuerst.
#
# Erweitern: Zeile in die passende Liste haengen. Gross-/Kleinschreibung egal,
# gesucht wird als Teilstring im normalisierten Empfaengernamen.
RULES: list[tuple[str, list[str]]] = [
    ("Bargeld", ["BARGELDBEZUG", "BANCOMAT BEZUG"]),
    ("Bankgebühren", ["GEBÜHRENBELASTUNG"]),
    # Vor Lebensmitteln: sonst faengt "MIGROS" den Migrolino-Tankstellenshop.
    # Parkieren gehoert hierher, nicht in eine eigene Zeile — es ist Autokosten.
    ("Auto", [
        "SOCAR", "MIGROL", "AVIA", "SHELL", "BP", "TANKSTELLE", "ALAIN HOCH",
        "BENZIN", "AGROLA", "TAMOIL", "TREIBSTOFFE", "PARKHAUS", "PARKING",
        "PARKINGPAY",
    ]),
    ("Lebensmittel", [
        "COOP", "MIGROS", "LIDL", "ALDI", "DENNER", "VOLG", "SPAR", "MANOR FOOD",
        "VOI", "AVEC",
    ]),
    ("Gastronomie", [
        "MCDONALD", "RESTAURANT", "PIZZERIA", "PIZZA", "SUITE SMALL", "MADE IN SUD",
        "LINDEN GRILL", "BABOS", "GOKI", "ELEMENTAL TRAINING", "STARBUCKS",
        "BURGER", "KEBAB", "KOFTE", "BAECKEREI", "BÄCKEREI", "CAFE", "CAFÉ",
        "GASTRO", "TAKE - AWAY", "TAKEAWAY", "KIOSK", "CONFISERIE", "CONDITOREI",
        "MEKONG", "ISTANBUL", "DIECI", "KFC", "SELECTA", "DRINKS OF THE WORLD",
        "ZESY", "BABA ORIENTAL",
    ]),
    ("OeV", ["SBB", "CFF", "TRENITALIA", "UBER", "VBL", "ZVV", "POSTAUTO"]),
    ("Software-Abos", [
        "ANTHROPIC", "CLAUDE", "SUPABASE", "LOVABLE", "APPLE", "GOOGLE", "OPENAI",
        "CHATGPT", "SUBMAGIC", "SUPERWALL", "VERCEL", "GITHUB", "SPOTIFY",
        "NETFLIX", "ADOBE",
    ]),
    ("Unterhaltung", ["CINEMA", "KINO", "STEAM", "SUPERCELL", "ALPAMARE"]),
    ("Persönliches", ["DROGERIEMARKT", "ROSSMANN", "COIFFEUR", "BARBERSHOP"]),
    ("Shopping", [
        "WOLF", "POWERFOOD", "METRO BOUTIQUE", "ZALANDO", "GALAXUS", "DIGITEC",
        "AMAZON", "DUTY FREE",
    ]),
    # Ganz unten: TWINT an Privatpersonen. Dylan: "fuer Essen und Freizeit".
    # Eigene Kategorie statt in Gastronomie gemischt — CHF 1'490 ueber ein
    # halbes Jahr sind zu viel, um sie in einer anderen Zahl verschwinden zu
    # lassen, und es ist ein anderes Verhalten als auswaerts essen.
    ("Essen & Freizeit", ["ZAHLUNG TWINT"]),
]

UNCATEGORIZED = "Unkategorisiert"

# Praefixe, die jede Buchung traegt und die nichts ueber den Empfaenger sagen.
NOISE = re.compile(r"^(einkauf\s+twint\s+|einkauf\s+|ls\s+|dauerauftrag\s+)", re.I)


def normalize(party: str) -> str:
    """Empfaengername auf das reduzieren, woran Regeln greifen koennen."""
    return re.sub(r"\s+", " ", NOISE.sub("", party or "")).strip().upper()


def categorize(party: str) -> str:
    """Erste passende Regel gewinnt; sonst sichtbar unkategorisiert.

    Wortgrenzen statt blossem Teilstring: "BP" soll die Tankstelle treffen und
    nicht mitten in einem anderen Namen zuschlagen. Kostet eine Zeile und
    erspart genau die Sorte Fehlbuchung, wegen der dieses Skript existiert.
    """
    name = normalize(party)
    for category, needles in RULES:
        for needle in needles:
            if re.search(rf"\b{re.escape(needle)}", name):
                return category
    return UNCATEGORIZED


# ── xlsx lesen ───────────────────────────────────────────────────────────────
def read_rows(path: str) -> list[list[str]]:
    with zipfile.ZipFile(path) as z:
        shared: list[str] = []
        if "xl/sharedStrings.xml" in z.namelist():
            for si in ET.fromstring(z.read("xl/sharedStrings.xml")):
                shared.append("".join(t.text or "" for t in si.iter(NS + "t")))
        sheets = [n for n in z.namelist() if re.match(r"xl/worksheets/sheet\d+\.xml$", n)]
        if not sheets:
            raise SystemExit(f"{path}: keine Tabelle gefunden")
        rows = []
        for row in ET.fromstring(z.read(sheets[0])).iter(NS + "row"):
            cells = []
            for c in row.iter(NS + "c"):
                v = c.find(NS + "v")
                if v is None:
                    cells.append("")
                elif c.get("t") == "s":
                    cells.append(shared[int(v.text)])
                else:
                    cells.append(v.text or "")
            rows.append(cells)
        return rows


def parse(rows: list[list[str]]) -> tuple[dict, dict]:
    """-> (Monatssummen, Diagnose). Nur Ausgaben; Einnahmen gehoeren nicht hierher."""
    header = next((i for i, r in enumerate(rows) if r and r[0] == "Datum"), None)
    if header is None:
        raise SystemExit("Kopfzeile 'Datum' nicht gefunden — ist das der Transaktionsexport?")

    months: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    unknown: dict[str, float] = defaultdict(float)
    count = 0

    for r in rows[header + 1:]:
        if len(r) < 3 or not r[0]:
            continue
        try:
            day = EXCEL_EPOCH + timedelta(days=float(r[0]))
            amount = float(r[2])
        except (ValueError, TypeError):
            continue  # Fusszeilen wie "Differenz" haben kein Datum/Betrag
        if amount >= 0:
            continue  # Einnahmen ueberspringen
        category = categorize(r[1])
        months[day.strftime("%Y-%m")][category] += -amount
        if category == UNCATEGORIZED:
            unknown[normalize(r[1])] += -amount
        count += 1

    spending = {m: {k: round(v, 2) for k, v in sorted(c.items(), key=lambda x: -x[1])}
                for m, c in sorted(months.items())}
    return spending, {"buchungen": count, "unbekannt": dict(sorted(unknown.items(), key=lambda x: -x[1]))}


# ── Selbsttest ───────────────────────────────────────────────────────────────
def selftest() -> None:
    """Der kleinste Test, der scheitert, wenn die Logik bricht."""
    assert categorize("Einkauf TWINT MIGROS BAHNHOF LUZERN") == "Lebensmittel", \
        "der Bahnhof-Migros ist der Grund, warum es dieses Skript gibt"
    assert categorize("Einkauf TWINT SOCAR FUCHSBERG NORD") == "Auto"
    assert categorize("DAUERAUFTRAG ALAIN HOCH") == "Auto", "Parkplatz"
    assert categorize("Zahlung TWINT , FRANCESCO") == "Essen & Freizeit"
    assert categorize("Bargeldbezug") == "Bargeld"
    assert categorize("ANTHROPIC") == "Software-Abos"
    assert categorize("Einkauf TWINT ELEMENTAL TRAINING") == "Gastronomie"
    assert categorize("SCHWEIZERISCHE BUNDESBAHNEN SBB") == "OeV"
    assert categorize("Irgendein Laden ohne Regel") == UNCATEGORIZED

    # Migrolino ist eine Tankstelle, kein Supermarkt — Reihenfolge zaehlt.
    assert categorize("MIGROL TANKSTELLE") == "Auto"

    # Excel-Serientage: 46174 = 2026-06-01, 46234 = 2026-07-31. Zwei Monate,
    # damit die Aufteilung wirklich geprueft wird und nicht nur die Summe.
    assert (EXCEL_EPOCH + timedelta(days=46174)).strftime("%Y-%m") == "2026-06"
    assert (EXCEL_EPOCH + timedelta(days=46234)).strftime("%Y-%m") == "2026-07"

    rows = [
        ["Datum", "Gegenpartei", "Betrag"],
        ["46234", "Einkauf TWINT MIGROS BAHNHOF LUZERN", "-3.45"],
        ["46234", "Bargeldbezug", "-700"],
        ["46174", "Einkauf COOP", "-20.55"],
        ["46234", "Lohn", "1282.4"],          # Einnahme -> ignoriert
        ["", "Differenz", "-1208.11"],        # Fusszeile -> ignoriert
    ]
    spending, diag = parse(rows)
    assert diag["buchungen"] == 3, diag
    assert spending["2026-07"]["Lebensmittel"] == 3.45, spending
    assert spending["2026-07"]["Bargeld"] == 700.0, spending
    assert spending["2026-06"]["Lebensmittel"] == 20.55, spending
    assert "2026-07" in spending and len(spending) == 2, spending
    print("Selbsttest ok")


def main() -> None:
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        raise SystemExit(__doc__)
    if args[0] == "--selftest":
        return selftest()

    spending, diag = parse(read_rows(args[0]))
    print(json.dumps({
        "spending": spending,
        "spendingUpdated": date.today().isoformat(),
    }, ensure_ascii=False, indent=2))
    print(f"\n{diag['buchungen']} Ausgabenbuchungen, {len(spending)} Monate", file=sys.stderr)
    if diag["unbekannt"]:
        total = sum(diag["unbekannt"].values())
        print(f"Unkategorisiert: CHF {total:,.2f} — groesste Posten:", file=sys.stderr)
        for name, amount in list(diag["unbekannt"].items())[:15]:
            print(f"  {name:<38} {amount:>9,.2f}", file=sys.stderr)


if __name__ == "__main__":
    main()
