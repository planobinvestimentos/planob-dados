# Imagens do PAINEL DO MERCADO do Plano B para o Telegram ("futuros imagem"). Uso: python3 imagem-futuros.py entrada.json saida.png
# Tipos (campo "tipo" do JSON): setores | cripto | commodities | dolar | medo. Todos levam: "titulo", "sub", "rodape" e, opcional, "logo" (caminho de um PNG).
#   setores:     itens [{nome, cod, v, pts}]
#   cripto:      btc {nome, v, p, v7}, itens [{nome, v, p}]
#   commodities: grupos [{nome, cor, itens:[{nome, un, p, v, dec}]}]
#   dolar:       dxy {v, p} (opcional), itens [{nome, cod, v, p}], destaque "BRL" (opcional)
#   medo:        valor, classe, hist [{rot, valor, classe}]
# Só usa matplotlib. Fonte Inter se existir (pacote fonts-inter no Actions), senão DejaVu. Cores do site: azul-marinho, vermelho, azul e azul-claro.
import json, math, os, sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, Rectangle, Polygon

plt.rcParams["font.family"] = ["Inter", "DejaVu Sans"]
plt.rcParams["axes.unicode_minus"] = False

AZUL, AZUL_ESC = "#272F63", "#1D2350"
LINHA = "#323B78"
VERDE, VERM, NEUTRO = "#1E8A5A", "#C0443C", "#4A5290"
BRANCO, SUAVE = "#FFFFFF", "#B7BCE0"
VERMELHO_MARCA = "#F0463C"
W = 1080
PX = 100.0 / 72.0


def pt(px):
    return px / PX


def fmt(v, c=2):
    return f"{abs(v):,.{c}f}".replace(",", "X").replace(".", ",").replace("X", ".")


def pct(v):
    return ("+" if v >= 0 else "−") + fmt(v) + "%"


def cor(v, neutro=0.0):
    if abs(v) <= neutro:
        return NEUTRO
    return VERDE if v > 0 else VERM


def novo(h):
    fig = plt.figure(figsize=(W / 100.0, h / 100.0), dpi=100)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, W)
    ax.set_ylim(h, 0)
    ax.axis("off")
    fig.patch.set_facecolor(AZUL)
    ax.add_patch(Rectangle((0, 0), W, h, color=AZUL, zorder=0))
    return fig, ax


def caixa(ax, x, y, w, h, fundo, raio=22, borda=None, z=1):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle=f"round,pad=0,rounding_size={raio}", fc=fundo, ec=borda or fundo, lw=2 if borda else 0, zorder=z))


def texto(ax, x, y, s, tam, cor_=BRANCO, peso="normal", ha="left", va="baseline", z=5, alpha=1):
    ax.text(x, y, s, fontsize=pt(tam), color=cor_, fontweight=peso, ha=ha, va=va, zorder=z, alpha=alpha)


def cabecalho(ax, d):
    logo = d.get("logo")
    if logo and os.path.exists(logo):
        try:
            img = plt.imread(logo)
            ih, iw = img.shape[0], img.shape[1]
            alt = 108.0
            larg = alt * iw / ih
            caixa(ax, 50, 26, larg + 40, alt + 28, BRANCO, raio=18, z=4)        # etiqueta branca: o logo aparece com as cores certas sobre o azul
            ax.imshow(img, extent=(70, 70 + larg, 26 + 14 + alt, 26 + 14), zorder=6, aspect="auto", interpolation="antialiased")
            y_tit = 232
            texto(ax, 50, y_tit, d["titulo"], 54, BRANCO, "bold")
            texto(ax, 50, y_tit + 44, d.get("sub", ""), 25, SUAVE)
            return y_tit + 44
        except Exception as e:
            print("aviso: logo não carregou:", e, file=sys.stderr)
    texto(ax, 50, 62, "PLANO B INVESTIMENTOS", 22, VERMELHO_MARCA, "bold")
    texto(ax, 50, 122, d["titulo"], 54, BRANCO, "bold")
    texto(ax, 50, 166, d.get("sub", ""), 25, SUAVE)
    return 166


def topo(d):
    return 210 if not (d.get("logo") and os.path.exists(d.get("logo"))) else 318


def rodape(ax, d, h):
    ax.add_patch(Rectangle((0, h - 12), W / 3, 12, color="#D62828", zorder=3))
    ax.add_patch(Rectangle((W / 3, h - 12), W / 3, 12, color="#1B5FAA", zorder=3))
    ax.add_patch(Rectangle((2 * W / 3, h - 12), W / 3, 12, color="#19A0DB", zorder=3))
    texto(ax, 50, h - 62, "planobinvestimentos.com  ·  t.me/planobinvestimentos", 23, BRANCO, "bold")
    texto(ax, 50, h - 30, d.get("rodape", ""), 20, SUAVE)


def fechar(ax):
    ax.set_xlim(0, W)


# ---------------------------------------------------------------- setores
def setores(d):
    it = d["itens"]
    TOP, TH, GAP, MX = topo(d), 188, 18, 50
    linhas = (len(it) + 2) // 2
    TW = (W - 2 * MX - GAP) / 2
    H = TOP + linhas * (TH + GAP) + 110
    fig, ax = novo(H)
    cabecalho(ax, d)
    for i, c in enumerate(list(it) + [None]):
        x = MX + (i % 2) * (TW + GAP)
        y = TOP + (i // 2) * (TH + GAP)
        if c is None:
            vs = [q["v"] for q in it]
            m = sum(vs) / len(vs)
            caixa(ax, x, y, TW, TH, AZUL_ESC, borda=SUAVE)
            texto(ax, x + 26, y + 46, "Média dos setores", 24, SUAVE)
            texto(ax, x + 26, y + 118, pct(m), 58, "#6EE7A8" if m > 0 else "#FF8F87" if m < 0 else SUAVE, "bold")
            alta, queda = sum(1 for v in vs if v > 0), sum(1 for v in vs if v < 0)
            texto(ax, x + 26, y + 160, f"{queda} de {len(vs)} em queda" if queda >= alta else f"{alta} de {len(vs)} em alta", 22, SUAVE)
            continue
        caixa(ax, x, y, TW, TH, cor(c["v"]))
        texto(ax, x + 26, y + 46, c["nome"], 27, BRANCO, "bold")
        lw = 14 * len(c["cod"]) + 28
        caixa(ax, x + TW - lw - 22, y + 20, lw, 38, "#00000033", raio=10)
        texto(ax, x + TW - 22 - lw / 2, y + 47, c["cod"], 20, BRANCO, "bold", ha="center")
        texto(ax, x + 26, y + 120, pct(c["v"]), 62, BRANCO, "bold")
        if c.get("pts") is not None:
            texto(ax, x + 26, y + 162, fmt(c["pts"]) + " pts", 22, BRANCO, alpha=0.85)
    rodape(ax, d, H)
    fechar(ax)
    return fig


# ---------------------------------------------------------------- cripto
def cripto(d):
    it, b = d["itens"], d["btc"]
    TOP, MX, GAP, BH = topo(d), 50, 18, 250
    TW, TH = (W - 2 * MX - 2 * GAP) / 3, 168
    linhas = (len(it) + 2) // 3
    H = TOP + BH + 70 + linhas * (TH + GAP) + 100
    fig, ax = novo(H)
    cabecalho(ax, d)
    caixa(ax, MX, TOP, W - 2 * MX, BH, cor(b["v"]), raio=26)
    texto(ax, MX + 32, TOP + 56, b.get("nome", "Bitcoin"), 32, BRANCO, "bold")
    texto(ax, MX + 32, TOP + 160, pct(b["v"]), 84, BRANCO, "bold")
    texto(ax, MX + 32, TOP + 214, "24 horas  ·  US$ " + fmt(b["p"]), 26, BRANCO, alpha=0.9)
    if b.get("v7") is not None:
        texto(ax, W - MX - 32, TOP + 214, "7 dias: " + pct(b["v7"]), 26, BRANCO, "bold", ha="right")
    y0 = TOP + BH + 48
    texto(ax, MX, y0, "Outras moedas (variação em 24 horas)", 24, SUAVE, "bold")
    y0 += 22
    for i, c in enumerate(it):
        x = MX + (i % 3) * (TW + GAP)
        y = y0 + (i // 3) * (TH + GAP)
        caixa(ax, x, y, TW, TH, cor(c["v"]), raio=18)
        nome = c["nome"] if len(c["nome"]) <= 12 else c["nome"][:11] + "…"
        texto(ax, x + 20, y + 40, nome, 24, BRANCO, "bold")
        texto(ax, x + 20, y + 100, pct(c["v"]), 40, BRANCO, "bold")
        p = c["p"]
        texto(ax, x + 20, y + 142, "US$ " + fmt(p, 0 if p >= 1000 else 2 if p >= 1 else 4), 21, BRANCO, alpha=0.88)
    rodape(ax, d, H)
    fechar(ax)
    return fig


# ---------------------------------------------------------------- commodities
def commodities(d):
    grupos = [g for g in d["grupos"] if g["itens"]]
    TOP, MX, RH, GAPR = topo(d), 50, 70, 8
    H = TOP + sum(46 + len(g["itens"]) * (RH + GAPR) + 22 for g in grupos) + 96
    fig, ax = novo(H)
    cabecalho(ax, d)
    y = TOP
    for g in grupos:
        ax.add_patch(Rectangle((MX, y + 8), 8, 28, color=g.get("cor", VERMELHO_MARCA), zorder=3))
        texto(ax, MX + 22, y + 34, g["nome"], 26, BRANCO, "bold")
        y += 46
        for c in g["itens"]:
            caixa(ax, MX, y, W - 2 * MX, RH, LINHA, raio=14)
            texto(ax, MX + 24, y + 33, c["nome"], 27, BRANCO, "bold")
            texto(ax, MX + 24, y + 58, c.get("un", ""), 18, SUAVE)
            texto(ax, 770, y + 45, fmt(c["p"], c.get("dec", 2)), 29, BRANCO, "bold", ha="right")
            caixa(ax, 800, y + 9, W - MX - 800 - 9, RH - 18, cor(c["v"]), raio=11, z=3)
            texto(ax, 800 + (W - MX - 800 - 9) / 2, y + 45, pct(c["v"]), 27, BRANCO, "bold", ha="center", z=6)
            y += RH + GAPR
        y += 22
    rodape(ax, d, H)
    fechar(ax)
    return fig


# ---------------------------------------------------------------- dólar no mundo
def dolar(d):
    it = d["itens"]
    TOP, MX, GAP = topo(d), 50, 14
    COLS = 4
    TW, TH = (W - 2 * MX - (COLS - 1) * GAP) / COLS, 150
    dxy = d.get("dxy")
    y = TOP
    linhas = (len(it) + 1 + COLS - 1) // COLS
    H = TOP + (196 if dxy else 0) + 70 + linhas * (TH + GAP) + 190 + 130
    fig, ax = novo(H)
    cabecalho(ax, d)
    if dxy:
        caixa(ax, MX, y, W - 2 * MX, 178, cor(dxy["v"]), raio=24)
        texto(ax, MX + 30, y + 52, "DXY · Índice do Dólar", 28, BRANCO, "bold")
        texto(ax, MX + 30, y + 140, pct(dxy["v"]), 68, BRANCO, "bold")
        texto(ax, W - MX - 30, y + 140, "Nível " + fmt(dxy["p"]), 30, BRANCO, "bold", ha="right")
        y += 196
    texto(ax, MX, y + 30, f"Dólar contra {len(it)} moedas", 26, BRANCO, "bold")
    texto(ax, W - MX, y + 30, "da maior queda à maior alta", 20, SUAVE, ha="right")
    texto(ax, MX, y + 58, "Verde: o dólar sobe contra a moeda  ·  Vermelho: o dólar cai", 19, SUAVE)
    y += 78
    vs = [c["v"] for c in it]
    media = sum(vs) / len(vs)
    for i, c in enumerate(list(it) + [None]):
        x = MX + (i % COLS) * (TW + GAP)
        yy = y + (i // COLS) * (TH + GAP)
        if c is None:
            caixa(ax, x, yy, TW, TH, AZUL_ESC, borda=SUAVE, raio=16)
            texto(ax, x + 16, yy + 34, "Média", 20, SUAVE)
            texto(ax, x + 16, yy + 92, pct(media), 36, "#6EE7A8" if media > 0.1 else "#FF8F87" if media < -0.1 else SUAVE, "bold")
            texto(ax, x + 16, yy + 130, f"das {len(it)} moedas", 18, SUAVE)
            continue
        destaque = d.get("destaque") == c.get("cod")
        caixa(ax, x, yy, TW, TH, cor(c["v"], 0.1), raio=16, borda=BRANCO if destaque else None)
        nome = c["nome"] if len(c["nome"]) <= 15 else c["nome"][:14] + "…"
        texto(ax, x + 16, yy + 34, nome, 21, BRANCO, "bold")
        texto(ax, x + 16, yy + 92, pct(c["v"]), 36, BRANCO, "bold")
        p = c["p"]
        texto(ax, x + 16, yy + 130, c["cod"] + " · " + fmt(p, 0 if p >= 1000 else 2 if p >= 10 else 3), 18, BRANCO, alpha=0.85)
    y += linhas * (TH + GAP) + 6
    alta, queda = sum(1 for v in vs if v > 0.1), sum(1 for v in vs if v < -0.1)
    neut = len(vs) - alta - queda
    bw = (W - 2 * MX - 2 * GAP) / 3
    for k, (rot, n, c_) in enumerate([("Alta", alta, "#6EE7A8"), ("Neutro", neut, SUAVE), ("Queda", queda, "#FF8F87")]):
        x = MX + k * (bw + GAP)
        caixa(ax, x, y, bw, 100, AZUL_ESC, borda=LINHA, raio=14)
        texto(ax, x + bw / 2, y + 36, rot, 20, SUAVE, ha="center")
        texto(ax, x + bw / 2, y + 82, str(n), 40, c_, "bold", ha="center")
    y += 116
    veredito = "Dólar em ALTA frente aos emergentes" if media > 0.1 else "Dólar em QUEDA frente aos emergentes" if media < -0.1 else "Dólar ESTÁVEL frente aos emergentes"
    caixa(ax, MX, y, W - 2 * MX, 64, AZUL_ESC, borda="#6EE7A8" if media > 0.1 else "#FF8F87" if media < -0.1 else SUAVE, raio=14)
    texto(ax, W / 2, y + 42, veredito, 25, BRANCO, "bold", ha="center")
    rodape(ax, d, H)
    fechar(ax)
    return fig


# ---------------------------------------------------------------- medo e ganância
FAIXAS = [(0, 25, "#C0443C"), (25, 47, "#E8803C"), (47, 55, "#E3B341"), (55, 76, "#7CC36B"), (76, 100, "#1E8A5A")]   # mesmas faixas do alternative.me


def cor_valor(v):
    for a, b, c in FAIXAS:
        if v < b:
            return c
    return FAIXAS[-1][2]


def arco(ax, cx, cy, r1, r2, v0, v1, cor_, n=40):
    t0, t1 = math.pi * (1 - v0 / 100.0), math.pi * (1 - v1 / 100.0)
    ext = [(cx + r2 * math.cos(t0 + (t1 - t0) * k / n), cy - r2 * math.sin(t0 + (t1 - t0) * k / n)) for k in range(n + 1)]
    inn = [(cx + r1 * math.cos(t1 + (t0 - t1) * k / n), cy - r1 * math.sin(t1 + (t0 - t1) * k / n)) for k in range(n + 1)]
    ax.add_patch(Polygon(ext + inn, closed=True, fc=cor_, ec=AZUL, lw=3, zorder=3))


def medo(d):
    v = float(d["valor"])
    MX = 50
    cy = topo(d) + 428
    H = cy + 240 + len(d.get("hist", [])) * 80 + 130
    fig, ax = novo(H)
    cabecalho(ax, d)
    cx, R1, R2 = W / 2, 230, 360
    for a, b, c in FAIXAS:
        arco(ax, cx, cy, R1, R2, a, b, c)
    for rot, val in [("0", 0), ("50", 50), ("100", 100)]:
        t = math.pi * (1 - val / 100.0)
        texto(ax, cx + (R2 + 34) * math.cos(t), cy - (R2 + 34) * math.sin(t) + (8 if val == 50 else 26), rot, 22, SUAVE, ha="center")
    # ponteiro
    t = math.pi * (1 - v / 100.0)
    ponta = (cx + (R2 - 18) * math.cos(t), cy - (R2 - 18) * math.sin(t))
    base1 = (cx + 16 * math.cos(t + math.pi / 2), cy - 16 * math.sin(t + math.pi / 2))
    base2 = (cx + 16 * math.cos(t - math.pi / 2), cy - 16 * math.sin(t - math.pi / 2))
    ax.add_patch(Polygon([ponta, base1, base2], closed=True, fc=BRANCO, ec=BRANCO, zorder=6))
    ax.add_patch(plt.Circle((cx, cy), 26, color=BRANCO, zorder=7))
    ax.add_patch(plt.Circle((cx, cy), 12, color=AZUL, zorder=8))
    texto(ax, cx, cy + 120, f"{int(round(v))}", 120, cor_valor(v), "bold", ha="center")
    texto(ax, cx, cy + 180, d["classe"], 38, BRANCO, "bold", ha="center")
    y = cy + 240
    for h in d.get("hist", []):
        caixa(ax, MX, y, W - 2 * MX, 70, LINHA, raio=14)
        ax.add_patch(plt.Circle((MX + 40, y + 35), 14, color=cor_valor(h["valor"]), zorder=5))
        texto(ax, MX + 74, y + 45, h["rot"], 27, BRANCO, "bold")
        texto(ax, W - MX - 250, y + 45, str(int(h["valor"])), 30, BRANCO, "bold", ha="right")
        texto(ax, W - MX - 22, y + 45, h["classe"], 24, SUAVE, ha="right")
        y += 80
    rodape(ax, d, H)
    fechar(ax)
    return fig


if __name__ == "__main__":
    d = json.load(open(sys.argv[1], encoding="utf-8"))
    fig = {"setores": setores, "cripto": cripto, "commodities": commodities, "dolar": dolar, "medo": medo}[d["tipo"]](d)
    fig.savefig(sys.argv[2], dpi=100, facecolor=AZUL)
