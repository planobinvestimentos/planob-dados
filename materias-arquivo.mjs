/* Guarda as matérias do site SEM PERDER NENHUMA.
   - saida/materias.json         = as 300 mais recentes (é o que a página "Notícias da bolsa" lista)
   - saida/materias-arquivo.json = todas as mais antigas (nunca é apagado; o site usa para abrir links de matérias antigas)
   Segurança: se o materias.json existir mas não puder ser lido, NÃO grava nada (em vez de recomeçar do zero e apagar as matérias). */
import fs from 'node:fs';
import path from 'node:path';

const ordem = (a, b) => ((b.data || '') + (b.criada || '')).localeCompare((a.data || '') + (a.criada || ''));

export function lerMaterias(saida, nome = 'materias.json') {
  const arq = path.join(saida, nome);
  if (!fs.existsSync(arq)) return { materias: [] };
  const txt = fs.readFileSync(arq, 'utf8');
  if (!txt.trim()) throw new Error(nome + ' existe mas está vazio: não vou gravar por cima (para não perder matérias)');
  const j = JSON.parse(txt);   // se estiver corrompido, dá erro e nada é gravado
  if (!j || !Array.isArray(j.materias)) throw new Error(nome + ' com formato inesperado: não vou gravar por cima');
  return j;
}

export function gravarMaterias(saida, novas, atuais, max = 300) {
  const vistos = new Set(), todas = [];
  for (const m of [...novas, ...atuais]) { const k = m.chave || m.slug; if (k && vistos.has(k)) continue; if (k) vistos.add(k); todas.push(m); }
  todas.sort(ordem);
  const recentes = todas.slice(0, max), antigas = todas.slice(max);
  if (antigas.length) {
    const arq = lerMaterias(saida, 'materias-arquivo.json');
    const ja = new Set((arq.materias || []).map((m) => m.chave || m.slug));
    const juntas = [...(arq.materias || []), ...antigas.filter((m) => !ja.has(m.chave || m.slug))].sort(ordem);
    fs.writeFileSync(path.join(saida, 'materias-arquivo.json'), JSON.stringify({ atualizado: new Date().toISOString(), materias: juntas }));
  }
  fs.writeFileSync(path.join(saida, 'materias.json'), JSON.stringify({ atualizado: new Date().toISOString(), materias: recentes }));
  return { recentes: recentes.length, arquivadas: antigas.length };
}
