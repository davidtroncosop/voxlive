import React, { useEffect, useState } from 'react';

interface VisualizerProps {
  isActive: boolean;
  color?: 'primary' | 'secondary';
  barCount?: number;
}

export const Visualizer: React.FC<VisualizerProps> = ({ 
  isActive, 
  color = 'primary', 
  barCount = 15 
}) => {
  const [heights, setHeights] = useState<number[]>(Array(barCount).fill(10));

  useEffect(() => {
    if (!isActive) {
      setHeights(Array(barCount).fill(8));
      return;
    }

    const interval = setInterval(() => {
      setHeights(
        Array.from({ length: barCount }, (_, i) => {
          const normalized = i / (barCount - 1); // 0 to 1
          const envelope = Math.sin(normalized * Math.PI); // 0 -> 1 -> 0 bell curve
          const baseHeight = 8;
          const dynamicBoost = (Math.random() * 0.7 + 0.3) * 58 * envelope;
          return Math.round(baseHeight + dynamicBoost);
        })
      );
    }, 85);

    return () => clearInterval(interval);
  }, [isActive, barCount]);

  return (
    <div className="visualizer-container">
      {heights.map((height, i) => (
        <div
          key={i}
          className="visualizer-bar"
          style={{
            height: `${height}px`,
            background: color === 'primary' 
              ? 'linear-gradient(to top, var(--color-primary), var(--color-primary-glow))' 
              : 'linear-gradient(to top, var(--color-secondary), var(--color-secondary-glow))',
            transition: 'height 0.1s cubic-bezier(0.4, 0, 0.2, 1)',
            opacity: isActive ? 0.9 : 0.3
          }}
        />
      ))}
    </div>
  );
};
export default Visualizer;
