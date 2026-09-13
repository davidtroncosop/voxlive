// Align the decoded signal with the source to allow for the codec's lookahead.
// A decodable packet or nonzero samples alone do not prove audio fidelity.
export function audioCorrelation(source, decoded, maxDelay = 480) {
  let best = -1;
  for (let delay = 0; delay <= maxDelay; delay++) {
    let dot = 0, sourceEnergy = 0, decodedEnergy = 0;
    for (let i = 1000; i < source.length - maxDelay; i++) {
      const x = source[i];
      const y = decoded[i + delay];
      dot += x * y;
      sourceEnergy += x * x;
      decodedEnergy += y * y;
    }
    const correlation = dot / Math.sqrt(sourceEnergy * decodedEnergy);
    if (Number.isFinite(correlation)) best = Math.max(best, correlation);
  }
  return best;
}
