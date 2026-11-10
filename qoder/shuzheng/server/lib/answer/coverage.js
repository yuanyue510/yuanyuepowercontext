/**
 * F5.4 未覆盖判定：两条可解释规则，同时成立才判"资料没讲到"。
 * 不使用任何检索分数阈值——hybridSearch 的 distances 是融合名次分，无上界、跨查询不可比。
 *
 *  ① 查询关键词在命中句里的覆盖率 < 0.34
 *  ② 命中结果中没有一句同时包含 ≥ 2 个查询词
 *
 * 返回值把判据本身带出去，评审能看到"哪个词没出现、哪一句含两个词"。
 */
export const COVERAGE_FLOOR = 0.34;

export function judgeCoverage(terms, hits) {
  const uniqueTerms = [...new Set(terms.filter((t) => t && t.length >= 2))];
  const hitTerms = new Set();
  let witness = null;

  for (const hit of hits) {
    const text = `${hit.sectionTitle ?? ''} ${hit.sentence}`;
    const contained = uniqueTerms.filter((t) => text.includes(t));
    contained.forEach((t) => hitTerms.add(t));
    if (!witness || contained.length > witness.terms.length) {
      witness = { id: hit.id, terms: contained, sentence: hit.sentence };
    }
  }

  const coverage = uniqueTerms.length === 0 ? 0 : hitTerms.size / uniqueTerms.length;
  const rule1LowCoverage = coverage < COVERAGE_FLOOR;
  const rule2NoSharedTermSentence = (witness?.terms.length ?? 0) < 2;
  const covered = !(rule1LowCoverage && rule2NoSharedTermSentence);

  return {
    covered,
    coverage: Number(coverage.toFixed(3)),
    coverageFloor: COVERAGE_FLOOR,
    rule1LowCoverage,
    rule2NoSharedTermSentence,
    terms: uniqueTerms,
    hitTerms: [...hitTerms],
    missedTerms: uniqueTerms.filter((t) => !hitTerms.has(t)),
    witnessTermCount: witness?.terms.length ?? 0,
    witness,
  };
}
