"""Gera o cartão da Pizza do Plano B (1080x1350) a partir de um JSON de dados REAIS calculados por pizza.mjs.
Uso: python3 pizza-arte.py dados.json saida.png
Precisa de: pip install playwright pillow (usa o Chrome já instalado no GitHub Actions, ou o Chromium do Playwright).
"""
import math, os, sys, base64, random, json
from playwright.sync_api import sync_playwright

AQUI = os.path.dirname(os.path.abspath(__file__))
IMG = os.path.join(AQUI, 'imagens', 'pizza')
ELPIS = IMG + '/elpis.png'; LOGO = IMG + '/logo.png'; AVATAR = IMG + '/avatar.png'
W, H = 1080, 1350
SLICES = {  # nome, cores, quadrante (ângulo inicial), offset do recorte
    'ibov': dict(nome='IBOVESPA', sub='Bolsa do Brasil', c1='#16a06a', c2='#0b6b47', a0=180, dx=-1, dy=-1, glyph='B3', seed=3, rug=0.5),
    'btc':  dict(nome='BITCOIN', sub='Cripto, em reais', c1='#e8890c', c2='#a8480a', a0=270, dx=1, dy=-1, glyph='₿', seed=7, rug=1.6),
    'spx':  dict(nome='S&P 500', sub='Bolsa dos EUA, em reais', c1='#3b7bf2', c2='#1d46b8', a0=0, dx=1, dy=1, glyph='500', seed=11, rug=0.45),
    'cdi':  dict(nome='CDI', sub='Renda fixa', c1='#8b5cf6', c2='#5b2bc2', a0=90, dx=-1, dy=1, glyph='%', seed=5, rug=0.05),
}
ORDEM = ['ibov', 'btc', 'spx', 'cdi']

def pt(cx, cy, r, ang):
    a = math.radians(ang); return cx + r * math.cos(a), cy + r * math.sin(a)

def setor(cx, cy, r, a0, a1):
    x0, y0 = pt(cx, cy, r, a0); x1, y1 = pt(cx, cy, r, a1)
    return f'M{cx:.1f},{cy:.1f} L{x0:.1f},{y0:.1f} A{r},{r} 0 0 1 {x1:.1f},{y1:.1f} Z'

def arco(cx, cy, r, a0, a1):
    x0, y0 = pt(cx, cy, r, a0); x1, y1 = pt(cx, cy, r, a1)
    return f'M{x0:.1f},{y0:.1f} A{r},{r} 0 0 1 {x1:.1f},{y1:.1f}'

def spark(k, cx, cy, R, a0):
    """linha decorativa que sobe da esquerda para a direita dentro da fatia (só enfeite; o CDI é a mais lisa, o Bitcoin a mais irregular)"""
    rnd = random.Random(SLICES[k]['seed']); rug = SLICES[k]['rug']
    dx, dy = SLICES[k]['dx'], SLICES[k]['dy']
    xa = cx if dx > 0 else cx - R * 0.96
    ya = cy if dy > 0 else cy - R * 0.96        # topo do quadrante
    larg = R * 0.96; alt = R * 0.96
    pts = []; n = 30
    for i in range(n):
        t = i / (n - 1)
        v = 0.12 + 0.70 * t + rnd.uniform(-0.06, 0.06) * rug * 2.2
        v = max(0.03, min(0.95, v))
        pts.append(f'{xa + larg * (0.06 + 0.88 * t):.1f},{ya + alt * (1 - v):.1f}')
    return ' '.join(pts)

def pizza_svg(cx, cy, R, lider=None, gap=5, extra=16, crust=22, mostrar_spark=True):
    out = []
    defs = []
    for k in ORDEM:
        s = SLICES[k]
        defs.append(f'<linearGradient id="g_{k}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{s["c1"]}"/><stop offset="1" stop-color="{s["c2"]}"/></linearGradient>')
    defs.append('<linearGradient id="g_crust" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f6cf86"/><stop offset=".55" stop-color="#d79a49"/><stop offset="1" stop-color="#b9772a"/></linearGradient>')
    defs.append('<filter id="sombra" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#000" flood-opacity=".45"/></filter>')
    for k in ORDEM:
        s = SLICES[k]; a0 = s['a0']; a1 = a0 + 90
        off = gap + (extra if lider == k else 0)
        dx, dy = s['dx'] * off, s['dy'] * off
        defs.append(f'<clipPath id="c_{k}"><path d="{setor(cx, cy, R, a0, a1)}"/></clipPath>')
        out.append(f'<g transform="translate({dx},{dy})" filter="url(#sombra)">')
        out.append(f'<path d="{arco(cx, cy, R + crust / 2 - 1, a0 + 0.6, a1 - 0.6)}" fill="none" stroke="url(#g_crust)" stroke-width="{crust}" stroke-linecap="butt"/>')
        out.append(f'<path d="{arco(cx, cy, R + crust - 5, a0 + 3, a1 - 3)}" fill="none" stroke="#fff3d1" stroke-opacity=".35" stroke-width="3"/>')
        out.append(f'<path d="{setor(cx, cy, R, a0, a1)}" fill="url(#g_{k})"/>')
        if mostrar_spark:
            out.append(f'<g clip-path="url(#c_{k})"><polyline points="{spark(k, cx, cy, R, a0)}" fill="none" stroke="#fff" stroke-opacity=".17" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></g>')
        if lider == k:
            out.append(f'<path d="{setor(cx, cy, R, a0, a1)}" fill="none" stroke="#fde68a" stroke-width="5" stroke-linejoin="round"/>')
        out.append('</g>')
    return f'<svg width="{W}" height="{H}" viewBox="0 0 {W} {H}" style="position:absolute;left:0;top:0"><defs>{"".join(defs)}</defs>{"".join(out)}</svg>'

def b64(p):
    return 'data:image/png;base64,' + base64.b64encode(open(p, 'rb').read()).decode()

CSS = '''
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1080px;height:1350px;overflow:hidden}
body{font-family:'Poppins',sans-serif;color:#fff;position:relative;
 background:radial-gradient(900px 700px at 22% 78%,#2c3f9c 0%,rgba(44,63,156,0) 62%),radial-gradient(900px 800px at 80% 30%,#1b2a74 0%,rgba(27,42,116,0) 65%),linear-gradient(165deg,#15215f 0%,#0a1130 70%)}
.abs{position:absolute}
.marca{position:absolute;left:56px;top:46px;display:flex;align-items:center;gap:16px}
.marca img{height:70px}
.marca .t1{font-weight:700;font-size:38px;letter-spacing:1px;line-height:1}
.marca .t2{font-weight:500;font-size:17px;letter-spacing:5.5px;margin-top:5px;opacity:.92}
.pill{position:absolute;border-radius:60px;font-weight:700;letter-spacing:2.5px;display:flex;align-items:center;justify-content:center;text-align:center}
.bloco{position:absolute;text-align:center}
.nome{font-weight:700;line-height:1}
.fatia{position:absolute;text-align:center;width:300px;margin-left:-150px}
.ico{display:inline-flex;align-items:center;justify-content:center;border-radius:50%;background:rgba(255,255,255,.2);font-weight:700}
.sombra{filter:drop-shadow(0 18px 28px rgba(0,0,0,.5))}
'''

def fatia_pos(k, cx, cy, R, fx=0.43, fy=0.39):
    s = SLICES[k]
    return cx + s['dx'] * R * fx, cy + s['dy'] * R * fy


def fontes_css():
    css = ''
    for peso, arq in [(300, 'Light'), (400, 'Regular'), (500, 'Medium'), (700, 'Bold')]:
        css += "@font-face{font-family:'Poppins';font-weight:%d;src:url('file://%s/fontes/Poppins-%s.ttf')}" % (peso, IMG, arq)
    return css

def html_cartao(d):
    cx, cy, R = 540, 808, 384
    sab = d['modo'] == 'sabado'
    lider = d['lider']
    p = [f'<style>{fontes_css()}{CSS}</style>', '<body>']
    p.append(pizza_svg(cx, cy, R, lider=lider, gap=5, extra=14, crust=22))
    p.append(f'<div class="marca"><img src="{b64(LOGO)}"><div><div class="t1">PLANO B</div><div class="t2">INVESTIMENTOS</div></div></div>')
    p.append('<div class="pill" style="right:56px;top:56px;width:340px;height:56px;background:rgba(255,255,255,.14);border:2px solid rgba(255,255,255,.5);font-size:21px;letter-spacing:1.5px">' + d['quando'] + '</div>')
    p.append('<div class="bloco" style="left:0;right:0;top:126px"><div style="font-weight:700;font-size:64px;line-height:1.05">Pizza do <span style="color:#fbbf24">Plano B</span></div>'
             '<div style="font-weight:700;font-size:31px;margin-top:4px;color:#fde68a">Rentabilidade de 01/01/' + d['ano'] + ' até o momento</div>'
             '<div style="font-weight:500;font-size:22px;margin-top:2px;opacity:.95">Ibovespa × Bitcoin × S&amp;P 500 × CDI · tudo em reais' + (' · resumo da semana' if sab else '') + '</div></div>')
    p.append('<div class="pill" style="left:90px;right:90px;top:284px;height:56px;background:#fbbf24;color:#1b1f3b;font-size:23px;letter-spacing:.8px">' + d['faixa'] + '</div>')
    for k in ORDEM:
        s = SLICES[k]; a = d['ativos'][k]; x, y = fatia_pos(k, cx, cy, R, fx=0.405, fy=0.385)
        if lider == k: x += s['dx'] * 14; y += s['dy'] * 14
        if s['dy'] > 0: y += 26
        dia = a['dia']
        if dia is None:
            cor = '#e5e7eb'; txt = '● sem pregão hoje'; rot = ''
        else:
            cor = '#bbf7d0' if dia >= 0 else '#fecaca'; seta = '▲' if dia >= 0 else '▼'
            txt = seta + ' ' + ('+' if dia >= 0 else '−') + f'{abs(dia):.2f}'.replace('.', ',') + '%'
            rot = ' <span style="font-weight:500;font-size:16px;color:#fff;opacity:.9">' + ('na semana' if sab else 'no dia') + '</span>'
        bg = '#fbbf24;color:#1b1f3b' if a['rank'] == 1 else 'rgba(255,255,255,.22);color:#fff'
        p.append(f'<div class="fatia" style="left:{x:.0f}px;top:{y-112:.0f}px;width:290px;margin-left:-145px">'
                 f'<div style="display:flex;align-items:center;justify-content:center;gap:10px"><span style="background:{bg};border-radius:20px;padding:2px 12px;font-weight:700;font-size:21px">{a["rank"]}º</span><span class="nome" style="font-size:31px">{s["nome"]}</span></div>'
                 f'<div class="nome" style="font-size:60px;margin-top:8px;letter-spacing:-1px">{a["total"]}</div>'
                 f'<div style="font-weight:500;font-size:16px;opacity:.9;margin-top:-2px">no ano</div>'
                 f'<div style="font-weight:500;font-size:23px;margin-top:10px">{a["hoje"]}</div>'
                 f'<div style="font-weight:700;font-size:24px;margin-top:2px;color:{cor}">{txt}{rot}</div></div>')
    p.append(f'<div class="abs" style="left:{cx-46}px;top:{cy-46}px;width:92px;height:92px;border-radius:50%;background:#0f1a52;border:5px solid #fbbf24;display:flex;align-items:center;justify-content:center;box-shadow:0 8px 22px rgba(0,0,0,.5)"><img src="{b64(LOGO)}" style="width:50px"></div>')
    p.append(f'<img class="abs" src="{b64(AVATAR)}" style="left:48px;top:1240px;width:96px;height:96px;border-radius:50%;border:4px solid #fbbf24;background:#2c3f9c">')
    p.append('<div class="abs" style="left:166px;top:1230px;width:870px;font-weight:300;font-size:17px;line-height:1.3;opacity:.97">'
             '<b style="font-weight:700;color:#fbbf24">Elpis lembra:</b> ' + d['rodape'] + ' Rentabilidade passada não garante ganho futuro. As fatias iguais são só para comparar: não são carteira recomendada. Fontes: ' + d['fontes'] + '.</div>')
    p.append('</body>')
    return '<html><head><meta charset="utf-8"></head>' + ''.join(p) + '</html>'

def render(html, saida):
    arq = saida + '.html'; open(arq, 'w', encoding='utf-8').write(html)
    with sync_playwright() as pw:
        try:
            b = pw.chromium.launch(channel='chrome')
        except Exception:
            b = pw.chromium.launch()
        pg = b.new_page(viewport={'width': W, 'height': H}, device_scale_factor=1)
        pg.goto('file://' + arq); pg.wait_for_timeout(800)
        pg.screenshot(path=saida, type='png'); b.close()
    os.remove(arq)

if __name__ == '__main__':
    dados = json.load(open(sys.argv[1], encoding='utf-8'))
    render(html_cartao(dados), sys.argv[2])
    print('ok', sys.argv[2])
