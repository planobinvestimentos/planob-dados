"""Gera o cartão da Pizza do Plano B a partir de um JSON de dados REAIS calculados por pizza.mjs.
Usa a arte-base (imagens/pizza/fundo-dia.png ou fundo-sabado.png, sem números) e escreve por cima os números do dia.
Uso: python3 pizza-arte.py dados.json saida.png
Precisa de: pip install playwright (usa o Chrome já instalado no GitHub Actions, ou o Chromium do Playwright)."""
import os, sys, json, base64
from playwright.sync_api import sync_playwright

AQUI = os.path.dirname(os.path.abspath(__file__))
IMG = os.path.join(AQUI, 'imagens', 'pizza')
W, H = 1122, 1402
H_SAIDA = 1220   # o Telegram corta fotos muito altas na prévia do chat (perdia a data e o rodapé); o aviso completo vai na legenda

# posições medidas na arte (x0, y0, x1, y1) das caixinhas de cada fatia
CAIXAS = {
    'ibov': dict(grande=(468, 569, 680, 639), meio=(471, 652, 662, 692), pequena=(470, 700, 652, 738), cor='#34d399'),
    'btc':  dict(grande=(751, 569, 967, 639), meio=(767, 652, 951, 692), pequena=(771, 700, 942, 738), cor='#fb923c'),
    'cdi':  dict(grande=(451, 853, 680, 925), meio=(487, 938, 659, 976), pequena=(487, 981, 661, 1020), cor='#a78bfa'),
    'spx':  dict(grande=(751, 853, 976, 925), meio=(766, 938, 937, 976), pequena=(765, 981, 936, 1020), cor='#60a5fa'),
}

def b64(p, mime='image/png'):
    return f'data:{mime};base64,' + base64.b64encode(open(p, 'rb').read()).decode()

def fontes_css():
    css = ''
    for peso, arq in [(300, 'Light'), (400, 'Regular'), (500, 'Medium'), (700, 'Bold')]:
        css += "@font-face{font-family:'Poppins';font-weight:%d;src:url('file://%s/fontes/Poppins-%s.ttf')}" % (peso, IMG, arq)
    return css

def caixa(b, extra=''):
    x0, y0, x1, y1 = b
    return f'left:{x0}px;top:{y0}px;width:{x1-x0}px;height:{y1-y0}px;{extra}'

def html_cartao(d):
    sab = d['modo'] == 'sabado'
    fundo = os.path.join(IMG, 'fundo-sabado.png' if sab else 'fundo-dia.png')
    p = []
    p.append(f'<img src="{b64(fundo)}" style="position:absolute;left:0;top:0;width:{W}px;height:{H}px">')
    # selo de data e faixa da liderança
    p.append('<div class="t fit" data-w="290" style="left:772px;top:32px;width:300px;height:56px;font-size:27px;font-weight:700;letter-spacing:.5px">' + d['quando'] + '</div>')
    p.append('<div class="t fit" data-w="620" style="left:442px;top:318px;width:630px;height:50px;font-size:25px;font-weight:700;color:#1b1f3b;letter-spacing:.4px">' + d['faixa'] + '</div>')
    for k, a in d['ativos'].items():
        c = CAIXAS[k]; lider = a['rank'] == 1
        gx0, gy0, gx1, gy1 = c['grande']
        if lider:  # contorno dourado na fatia líder
            p.append(f'<div style="position:absolute;{caixa((gx0-5, gy0-5, gx1+5, gy1+5))}border:3px solid #fbbf24;border-radius:22px;box-shadow:0 0 18px rgba(251,191,36,.75)"></div>')
        # percentual grande
        p.append(f'<div class="t fit" data-w="{gx1-gx0-16}" style="{caixa(c["grande"])}font-size:46px;font-weight:700;letter-spacing:-1px">{a["total"]}<span class="u"></span></div>')
        # medalha de posição (aba na borda de cima da caixa grande)
        bg = 'background:#fbbf24;color:#1b1f3b;border:2px solid #fff3c4' if lider else f'background:#0f1a52;color:#fff;border:2px solid {c["cor"]}'
        p.append(f'<div class="t" style="left:{gx0+14}px;top:{gy0-16}px;width:56px;height:30px;border-radius:16px;font-size:18px;font-weight:700;{bg}">{a["rank"]}º</div>')
        # valor (pontos / R$ / taxa)
        p.append(f'<div class="t fit" data-w="{c["meio"][2]-c["meio"][0]-16}" style="{caixa(c["meio"])}font-size:25px;font-weight:500">{a["hoje"]}</div>')
        # variação com setinha
        dia = a['dia']; rot = 'semana' if sab else 'hoje'
        if dia is None:
            conteudo = '<span style="font-weight:500;font-size:17px;opacity:.9">sem pregão hoje</span>'
        else:
            up = dia >= 0; cor = '#34d399' if up else '#f87171'
            seta = f'<span style="display:inline-block;width:0;height:0;border-left:9px solid transparent;border-right:9px solid transparent;{"border-bottom" if up else "border-top"}:15px solid {cor};margin-right:7px;vertical-align:1px"></span>'
            txt = ('+' if up else '−') + f'{abs(dia):.2f}'.replace('.', ',') + '%'
            conteudo = f'{seta}<span style="color:{cor};font-weight:700;font-size:21px">{txt}</span><span style="font-weight:500;font-size:15px;margin-left:6px;opacity:.95">{rot}</span>'
        p.append(f'<div class="t fit" data-w="{c["pequena"][2]-c["pequena"][0]-14}" style="{caixa(c["pequena"])}">{conteudo}</div>')
    css = fontes_css() + f'''*{{box-sizing:border-box;margin:0;padding:0}}html,body{{width:{W}px;height:{H}px;overflow:hidden;background:#0a1130}}
body{{font-family:'Poppins',sans-serif;color:#fff;position:relative}}
.t{{position:absolute;display:flex;align-items:center;justify-content:center;text-align:center;white-space:nowrap}}
'''
    js = '''<script>
document.fonts.ready.then(()=>{
 document.querySelectorAll('.fit').forEach(el=>{const w=+el.dataset.w;let s=parseFloat(el.style.fontSize)||20;
   const inner=()=>{const r=document.createRange();r.selectNodeContents(el);return r.getBoundingClientRect().width};
   let n=0;while(inner()>w&&n++<40){s-=1;el.style.fontSize=s+'px';}});
 document.body.dataset.pronto='1';});
</script>'''
    return '<html><head><meta charset="utf-8"><style>' + css + '</style></head><body>' + ''.join(p) + js + '</body></html>'

def render(html, saida):
    arq = saida + '.html'; open(arq, 'w', encoding='utf-8').write(html)
    with sync_playwright() as pw:
        try:
            b = pw.chromium.launch(channel='chrome')
        except Exception:
            b = pw.chromium.launch()
        pg = b.new_page(viewport={'width': W, 'height': H}, device_scale_factor=1)
        pg.goto('file://' + arq); pg.wait_for_selector('body[data-pronto="1"]', timeout=15000); pg.wait_for_timeout(300)
        pg.screenshot(path=saida, type='png', clip={'x': 0, 'y': 0, 'width': W, 'height': H_SAIDA}); b.close()
    os.remove(arq)

if __name__ == '__main__':
    dados = json.load(open(sys.argv[1], encoding='utf-8'))
    render(html_cartao(dados), sys.argv[2])
    print('ok', sys.argv[2])
