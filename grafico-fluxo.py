# Gráfico de barras do fluxo estrangeiro na B3. Uso: python3 grafico-fluxo.py entrada.json saida.png
# entrada.json: {"titulo": "...", "dias": ["17/09", ...], "valores": [em R$ bilhões, ...]}
import json, sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

d = json.load(open(sys.argv[1], encoding="utf-8"))
fig, ax = plt.subplots(figsize=(8.5, 4.6), dpi=130)
cores = ["#2E7D32" if v >= 0 else "#C62828" for v in d["valores"]]
ax.bar(range(len(d["valores"])), d["valores"], color=cores, width=0.75)
ax.axhline(0, color="#333", linewidth=0.8)
ax.set_xticks(range(len(d["dias"])))
ax.set_xticklabels(d["dias"], rotation=45, ha="right", fontsize=8)
ax.set_ylabel("R$ bilhões", fontsize=9)
ax.set_title(d["titulo"], fontsize=11, fontweight="bold")
ax.grid(axis="y", alpha=0.25)
for lado in ("top", "right"):
    ax.spines[lado].set_visible(False)
fig.text(0.99, 0.01, "Plano B Investimentos · dados: B3", ha="right", va="bottom", fontsize=7, color="#777")
fig.tight_layout()
fig.savefig(sys.argv[2])
