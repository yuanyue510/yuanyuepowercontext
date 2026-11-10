import { el } from '../api.js';
import { textWithTerms } from './highlight.js';

function channelNote(c) {
  const parts = c.channels.map((ch) =>
    ch.type === 'vector' ? `向量第 ${ch.rank} 位（cosine ${ch.score}）` : `全文「${ch.keyword}」第 ${ch.rank} 位`,
  );
  // 融合名次分跨查询不可比，界面只报名次与命中通道；分数只在向量通道标注（它是有界 cosine）。
  return `${c.channelCount} 路召回：${parts.join(' ｜ ')}`;
}

export function evidenceCard(c, onLocate) {
  const context = c.context?.length
    ? el('details', { class: 'ctx' }, [
        el('summary', { text: `同节上下文 ±2 句（${c.context.length} 句）` }),
        el(
          'ul',
          {},
          c.context.map((n) => el('li', { class: n.sentNo < c.sentNo ? 'before' : 'after', text: `${n.sentNo}. ${n.sentence}` })),
        ),
      ])
    : null;

  return el('article', { class: `card${c.matchedTerms.length ? ' matched' : ''}` }, [
    el('header', { class: 'card-head' }, [
      el('span', { class: 'ref', text: `〔${c.ref}〕` }),
      el('strong', { text: c.datasetName }),
      el('span', { class: 'crumb', text: c.sectionPath }),
      c.hasFormula ? el('span', { class: 'tag', text: '含公式' }) : null,
      c.mergedCount > 1 ? el('span', { class: 'tag', text: `R1 合并 ${c.mergedCount} 句` }) : null,
    ]),
    el('p', { class: 'sentence' }, [textWithTerms(c.sentence, c.matchedTerms)]),
    context,
    el('footer', { class: 'card-meta' }, [
      el('span', { class: 'why', text: channelNote(c) }),
      el('span', { class: 'terms', text: c.matchedTerms.length ? `命中查询词：${c.matchedTerms.join('、')}` : '未命中原句词，仅语义相近' }),
      el('span', { class: 'anchor', text: `出处锚点 char ${c.charStart}–${c.charEnd}｜第 ${c.sentNo} 句` }),
      el(
        'button',
        { class: 'locate', onclick: () => onLocate(c) },
        ['定位原文'],
      ),
    ]),
  ]);
}
