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
      setHeights(Array(barCount).fill(10));
      return;
    }

    const interval = setInterval(() => {
      setHeights(prev => 
        prev.map(() => Math.floor(Math.random() * 55) + 15) // Random height between 15px and 70px
      );
    }, 100);

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
