import React, { useEffect, useState } from 'react';
import QRCodeLib from 'qrcode';

interface QRCodeProps {
  value: string;
  size?: number;
  fgColor?: string;
  bgColor?: string;
  className?: string;
}

export const QRCode: React.FC<QRCodeProps> = ({
  value,
  size = 200,
  fgColor = '#000000',
  bgColor = '#ffffff',
  className = '',
}) => {
  const [svgDataUrl, setSvgDataUrl] = useState<string>('');

  useEffect(() => {
    if (!value) {
      setSvgDataUrl('');
      return;
    }

    // Generate high-contrast, standard ISO/IEC 18004 compliant QR Data URL
    QRCodeLib.toDataURL(value, {
      margin: 1,
      width: size * 2, // 2x for sharp rendering on Retina / high-DPI screens
      color: {
        dark: fgColor,
        light: bgColor,
      },
      errorCorrectionLevel: 'M',
    })
      .then((url) => {
        setSvgDataUrl(url);
      })
      .catch((err) => {
        console.error('Failed to generate QR Code:', err);
      });
  }, [value, size, fgColor, bgColor]);

  if (!svgDataUrl) {
    return (
      <div 
        style={{ 
          width: size, 
          height: size, 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'center',
          background: bgColor,
          borderRadius: '8px',
          color: '#666',
          fontSize: '12px'
        }}
      >
        Generando QR...
      </div>
    );
  }

  return (
    <img
      src={svgDataUrl}
      alt={`Código QR para ${value}`}
      width={size}
      height={size}
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: '8px',
        display: 'block',
        background: bgColor,
      }}
    />
  );
};

export default QRCode;
