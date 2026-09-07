import React, { useEffect, useState } from 'react';

interface VisualizerProps {
  isActive: boolean;
  color?: 'primary' | 'secondary';
  barCount?: number;
  audioLevel?: number; // 0 to 100
}

export const Visualizer: React.FC<VisualizerProps> = ({ 
  isActive, 
  color = 'primary', 
  barCount = 19,
  audioLevel
}) => {
  const [heights, setHeights] = useState<number[]>(Array(barCount).fill(8));

  useEffect(() => {
    if (!isActive) {
      setHeights(Array(barCount).fill(6));
      return;
    }

    const interval = setInterval(() => {
      setHeights(
        Array.from({ length: barCount }, (_, i) => {
          const normalized = i / (barCount - 1); // 0 to 1
          const envelope = Math.sin(normalized * Math.PI); // 0 -> 1 -> 0 bell curve
          const baseHeight = 6;
          
          let dynamicBoost = 0;
          if (typeof audioLevel === 'number' && audioLevel > 0) {
            // Reacciona al nivel real de dB / volumen del micrófono
            const scaled = Math.min(100, Math.max(0, audioLevel)) / 100;
            const variance = (Math.random() * 0.4 + 0.8);
            dynamicBoost = scaled * 62 * envelope * variance;
          } else {
            // Fluctuación fluida orgánica de audio
            dynamicBoost = (Math.random() * 0.6 + 0.4) * 52 * envelope;
          }

          return Math.max(6, Math.round(baseHeight + dynamicBoost));
        })
      );
    }, 60);

    return () => clearInterval(interval);
  }, [isActive, barCount, audioLevel]);

  return (
    <div className="visualizer-container">
      {heights.map((height, i) => (
        <div
          key={i}
          className="visualizer-bar"
          style={{
            height: `${height}px`,
            background: color === 'primary' 
              ? 'linear-gradient(to top, var(--blue), var(--blue-vibrant))' 
              : 'linear-gradient(to top, var(--blue-dark), var(--blue-vibrant))',
            boxShadow: isActive ? '0 0 10px rgba(56, 189, 248, 0.4)' : 'none',
            borderRadius: 0,
            transition: 'height 0.06s cubic-bezier(0.2, 0, 0.2, 1)',
            opacity: isActive ? 0.95 : 0.25
          }}
        />
      ))}
    </div>
  );
};
export default Visualizer;
