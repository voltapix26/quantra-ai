# Quantra AI — 3-year financial model (assumption-driven, live Excel formulas).
# Every output is a FORMULA off the Assumptions sheet: change a driver, model responds.
# Nothing here is historical — Quantra has no revenue yet. All figures are projections.
import os
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

OUT_DIR = os.path.join(os.path.expanduser('~'), 'Desktop', 'Quantra AI')
os.makedirs(OUT_DIR, exist_ok=True)
OUT = os.path.join(OUT_DIR, 'Quantra_AI_Financial_Model.xlsx')

DARK = 'FF0A0F1C'; MINT = 'FF34D399'; CYAN = 'FF22D3EE'; LIGHT = 'FFF2F5F9'; AMBER = 'FFFFF3D6'
H = Font(bold=True, color='FFFFFFFF', size=11)
B = Font(bold=True); SM = Font(size=9, italic=True, color='FF667085')
fillH = PatternFill('solid', fgColor=DARK); fillS = PatternFill('solid', fgColor=LIGHT)
fillIn = PatternFill('solid', fgColor='FFFFF9E6')   # yellow = editable input
thin = Border(bottom=Side(style='thin', color='FFDDDDDD'))

wb = Workbook()

# ================= ASSUMPTIONS =================
a = wb.active; a.title = 'Assumptions'
a['A1'] = 'QUANTRA AI — MODEL ASSUMPTIONS'; a['A1'].font = Font(bold=True, size=14)
a['A2'] = 'Yellow cells are inputs. Every figure on the other sheets is a formula off this sheet — change a driver and the model recalculates.'
a['A2'].font = SM
a['A3'] = 'PROJECTIONS ONLY. Quantra has no revenue and no active users to date; there is no historical data in this model.'
a['A3'].font = Font(bold=True, size=9, color='FFB00020')

rows = [
    ('GROWTH', None, None),
    ('New signups — month 1', 500, 'Post-launch, funded marketing begins'),
    ('Signup growth — months 2-12 (m/m)', 0.18, 'Early compounding from paid + share loop'),
    ('Signup growth — year 2 (m/m)', 0.10, 'Tapers as base grows'),
    ('Signup growth — year 3 (m/m)', 0.06, 'Maturing funnel'),
    ('Monthly churn — free users', 0.08, 'Share of active free users lost per month'),
    ('Monthly churn — paying users', 0.05, 'SaaS-typical for prosumer fintech'),
    ('MONETISATION', None, None),
    ('Free → paid conversion', 0.04, 'Conservative; industry prosumer range 2-6%'),
    ('Pro price (US$/month)', 9.99, 'Plan already built in product'),
    ('Ultimate price (US$/month)', 24.99, 'Plan already built in product'),
    ('Mix — share on Pro', 0.80, 'Remainder on Ultimate'),
    ('Payment processing fee', 0.03, 'Stripe + FX'),
    ('COSTS (US$/month)', None, None),
    ('Salaries — year 1', 26000, 'Founder + 3 hires ramping (eng, data, growth)'),
    ('Salaries — year 2', 52000, 'Team of ~7'),
    ('Salaries — year 3', 72000, 'Team of ~10'),
    ('Market data & licences — year 1', 2000, 'RapidAPI/Finnhub paid tiers + first exchange licence'),
    ('Market data & licences — year 2', 6000, 'Gulf + NSE/BSE licensed feeds'),
    ('Market data & licences — year 3', 10000, 'Broader licensed coverage'),
    ('Infrastructure & tooling — year 1', 800, 'Paid instance, DB, CDN, AI API'),
    ('Infrastructure & tooling — year 2', 3000, 'Scale with users'),
    ('Infrastructure & tooling — year 3', 7000, 'Scale with users'),
    ('Marketing — year 1', 15000, 'GCC + India performance + content'),
    ('Marketing — year 2', 35000, ''),
    ('Marketing — year 3', 55000, ''),
    ('G&A, legal & compliance — year 1', 6000, 'ADGM/UAE regulatory path, audit, insurance'),
    ('G&A, legal & compliance — year 2', 8000, ''),
    ('G&A, legal & compliance — year 3', 10000, ''),
    ('FUNDING', None, None),
    ('Seed raise (US$)', 2500000, 'This round'),
]
r = 5
KEY = {}
for label, val, note in rows:
    if val is None:
        a.cell(r, 1, label).font = H; a.cell(r, 1).fill = fillH
        a.cell(r, 2).fill = fillH; a.cell(r, 3).fill = fillH
    else:
        a.cell(r, 1, label)
        c = a.cell(r, 2, val); c.fill = fillIn; c.font = B
        if isinstance(val, float) and val < 1: c.number_format = '0.0%'
        elif isinstance(val, (int, float)) and val >= 1000: c.number_format = '#,##0'
        else: c.number_format = '#,##0.00'
        a.cell(r, 3, note).font = SM
        KEY[label] = f'Assumptions!$B${r}'
    r += 1
a.column_dimensions['A'].width = 38; a.column_dimensions['B'].width = 14; a.column_dimensions['C'].width = 52

K = KEY
# ================= MONTHLY MODEL =================
m = wb.create_sheet('Monthly Model')
m['A1'] = 'MONTHLY MODEL — 36 MONTHS (all cells are formulas)'; m['A1'].font = Font(bold=True, size=13)
m['A2'] = 'Month 1 = first month post-funding / launch.'; m['A2'].font = SM
LAB = {
    4: 'Month', 5: 'New signups', 6: 'Active users (after churn)', 7: 'Paying customers',
    8: 'Blended ARPU (US$)', 9: 'MRR (US$)', 10: 'Revenue (US$)',
    12: 'Salaries', 13: 'Market data & licences', 14: 'Infrastructure', 15: 'Marketing',
    16: 'G&A / legal', 17: 'Payment fees', 18: 'Total expense', 19: 'EBITDA', 20: 'Cash balance',
}
for row, lab in LAB.items():
    c = m.cell(row, 1, lab); c.font = B
    if row in (10, 18, 19, 20): c.fill = fillS
m.column_dimensions['A'].width = 26

for i in range(1, 37):
    col = get_column_letter(1 + i); L = col
    prev = get_column_letter(i) if i > 1 else None
    m[f'{L}4'] = i; m[f'{L}4'].font = B; m[f'{L}4'].alignment = Alignment(horizontal='center')
    # new signups
    if i == 1:
        m[f'{L}5'] = f"={K['New signups — month 1']}"
    elif i <= 12:
        m[f'{L}5'] = f"={prev}5*(1+{K['Signup growth — months 2-12 (m/m)']})"
    elif i <= 24:
        m[f'{L}5'] = f"={prev}5*(1+{K['Signup growth — year 2 (m/m)']})"
    else:
        m[f'{L}5'] = f"={prev}5*(1+{K['Signup growth — year 3 (m/m)']})"
    # active users
    m[f'{L}6'] = (f"={L}5" if i == 1 else f"={prev}6*(1-{K['Monthly churn — free users']})+{L}5")
    # paying customers
    m[f'{L}7'] = (f"={L}5*{K['Free → paid conversion']}" if i == 1
                  else f"={prev}7*(1-{K['Monthly churn — paying users']})+{L}5*{K['Free → paid conversion']}")
    # ARPU / MRR / revenue
    m[f'{L}8'] = (f"={K['Pro price (US$/month)']}*{K['Mix — share on Pro']}"
                  f"+{K['Ultimate price (US$/month)']}*(1-{K['Mix — share on Pro']})")
    m[f'{L}9'] = f"={L}7*{L}8"
    m[f'{L}10'] = f"={L}9"
    # costs — pick the year's driver
    def yearly(k1, k2, k3):
        return f"=IF({L}4<=12,{K[k1]},IF({L}4<=24,{K[k2]},{K[k3]}))"
    m[f'{L}12'] = yearly('Salaries — year 1', 'Salaries — year 2', 'Salaries — year 3')
    m[f'{L}13'] = yearly('Market data & licences — year 1', 'Market data & licences — year 2', 'Market data & licences — year 3')
    m[f'{L}14'] = yearly('Infrastructure & tooling — year 1', 'Infrastructure & tooling — year 2', 'Infrastructure & tooling — year 3')
    m[f'{L}15'] = yearly('Marketing — year 1', 'Marketing — year 2', 'Marketing — year 3')
    m[f'{L}16'] = yearly('G&A, legal & compliance — year 1', 'G&A, legal & compliance — year 2', 'G&A, legal & compliance — year 3')
    m[f'{L}17'] = f"={L}10*{K['Payment processing fee']}"
    m[f'{L}18'] = f"=SUM({L}12:{L}17)"
    m[f'{L}19'] = f"={L}10-{L}18"
    m[f'{L}20'] = (f"={K['Seed raise (US$)']}+{L}19" if i == 1 else f"={prev}20+{L}19")
    for row in (5, 6, 7, 9, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20):
        m[f'{L}{row}'].number_format = '#,##0'
    m[f'{L}8'].number_format = '0.00'
    m.column_dimensions[L].width = 11

# ================= ANNUAL SUMMARY =================
s = wb.create_sheet('Annual Summary', 0)
s['A1'] = 'QUANTRA AI — 3-YEAR PROJECTION SUMMARY'; s['A1'].font = Font(bold=True, size=15)
s['A2'] = 'Projections only — no historical revenue exists. Driven entirely by the Assumptions sheet.'
s['A2'].font = Font(bold=True, size=9, color='FFB00020')
hdr = ['', 'Year 1', 'Year 2', 'Year 3']
for i, h in enumerate(hdr):
    c = s.cell(4, i + 1, h); c.font = H; c.fill = fillH; c.alignment = Alignment(horizontal='center')

def rng(row, y):
    a1 = get_column_letter(2 + (y - 1) * 12); a2 = get_column_letter(1 + y * 12)
    return f"'Monthly Model'!{a1}{row}:{a2}{row}"
def endcol(y): return get_column_letter(1 + y * 12)

metrics = [
    ('Total customers (paying, end of year)', lambda y: f"='Monthly Model'!{endcol(y)}7"),
    ('Active users (end of year)', lambda y: f"='Monthly Model'!{endcol(y)}6"),
    ('Total Revenue (US$)', lambda y: f"=SUM({rng(10, y)})"),
    ('Total Expense (US$)', lambda y: f"=SUM({rng(18, y)})"),
    ('EBITDA (US$)', lambda y: f"=SUM({rng(19, y)})"),
    ('EBITDA margin', lambda y: f"=IFERROR(SUM({rng(19, y)})/SUM({rng(10, y)}),0)"),
    ('Cash balance (end of year, US$)', lambda y: f"='Monthly Model'!{endcol(y)}20"),
    ('Exit MRR (US$)', lambda y: f"='Monthly Model'!{endcol(y)}9"),
    ('ARR run-rate (US$)', lambda y: f"='Monthly Model'!{endcol(y)}9*12"),
]
r = 5
for label, f in metrics:
    c = s.cell(r, 1, label); c.font = B; c.border = thin
    for y in (1, 2, 3):
        cc = s.cell(r, 1 + y, f(y))
        cc.number_format = '0.0%' if 'margin' in label else '#,##0'
        cc.border = thin
        if 'EBITDA (US$)' in label or 'Revenue' in label: cc.font = B
    r += 1
s.column_dimensions['A'].width = 36
for col in 'BCD': s.column_dimensions[col].width = 16

r += 1
s.cell(r, 1, 'RUNWAY & THE SERIES A').font = Font(bold=True, size=12); r += 1
s.cell(r, 1, 'Cash-out month at this plan (seed only)').font = B
s.cell(r, 2, "=IFERROR(MATCH(-0.000001,'Monthly Model'!B20:AK20,-1)+1,\">36\")").alignment = Alignment(horizontal='center')
r += 1
for note in [
    'The US$2.5M seed funds operations to roughly month 34 at the spend above. Year-3 closing cash is NEGATIVE by design of this plan — it is not a going-concern assumption.',
    'The plan assumes a Series A in year 3, raised against a ~US$1M ARR run-rate, a live product and a multi-year public accuracy record.',
    'If no Series A is raised: marketing and hiring throttle back in year 3 to hold cash positive — growth slows, the company survives. That lever is deliberate, not a fix applied after the fact.',
    'EBITDA is negative across all three years. This is a growth-stage SaaS plan; breakeven is not claimed inside the seed window and is not modelled.',
]:
    s.cell(r, 1, '•  ' + note).font = Font(size=9.5); r += 1

r += 1
s.cell(r, 1, 'KEY & CRITICAL ASSUMPTIONS').font = Font(bold=True, size=12); r += 1
for note in [
    'Conversion: 4% of active free users become paying — conservative vs the 2-6% prosumer range.',
    'Pricing: Pro US$9.99 / Ultimate US$24.99 per month — both plans already built in the product.',
    'Churn: 5%/month paying, 8%/month free.',
    'Market penetration: Year-3 exit base is a small fraction of a percent of GCC + India retail investors — growth is marketing-led, not penetration-capped.',
    'Costs scale in three steps (Y1/Y2/Y3): team, licensed exchange data, infrastructure, marketing, G&A.',
    'The model assumes the seed closes and launch begins in month 1; no revenue is modelled before that.',
    'Not included: enterprise/API revenue, licensed-data resale, or any exit assumption — all upside, none relied upon.',
]:
    s.cell(r, 1, '•  ' + note).font = Font(size=9.5); r += 1

r += 1
s.cell(r, 1, 'USE OF FUNDS — US$2.5M').font = Font(bold=True, size=12); r += 1
for label, pct, amt, what in [
    ('Team', '35%', 875000, '4 engineers + data specialist + growth lead; 24-month runway'),
    ('Data & infrastructure', '30%', 750000, 'Licensed Gulf + NSE/BSE feeds, premium APIs, production hosting'),
    ('Growth & go-to-market', '20%', 500000, 'GCC + India marketing, app-store launches, referral loops'),
    ('Regulatory & legal', '10%', 250000, 'ADGM/UAE footing for a paid research product'),
    ('Reserve', '5%', 125000, 'Contingency, audit, insurance'),
]:
    s.cell(r, 1, label).font = B
    s.cell(r, 2, pct).alignment = Alignment(horizontal='center')
    c = s.cell(r, 3, amt); c.number_format = '#,##0'
    s.cell(r, 4, what).font = SM
    r += 1

r += 2
s.cell(r, 1, 'DISCLAIMER — These are forward-looking projections built on the stated assumptions, not forecasts or '
             'guarantees. Quantra AI has no revenue and no active users as of the model date. Actual results will differ.'
       ).font = Font(size=9, italic=True, color='FFB00020')

wb.save(OUT)
print('SAVED:', OUT)
