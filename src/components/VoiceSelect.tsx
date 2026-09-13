import React, { useState, useRef, useEffect } from 'react';
import { Volume2, Check } from 'lucide-react';
import type { LiveVoiceOption } from '../../shared/translationProvider';

interface VoiceSelectProps {
  value: string;
  options: LiveVoiceOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  compact?: boolean;
  id?: string;
}

export const VoiceSelect: React.FC<VoiceSelectProps> = ({
  value,
  options,
  onChange,
  disabled = false,
  compact = false,
  id,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find((opt) => opt.id === value) || options[0];

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key === 'Escape') {
      setIsOpen(false);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setIsOpen(!isOpen);
    } else if (e.key === 'ArrowDown' && isOpen) {
      e.preventDefault();
      const currentIndex = options.findIndex((opt) => opt.id === value);
      const nextIndex = (currentIndex + 1) % options.length;
      onChange(options[nextIndex].id);
    } else if (e.key === 'ArrowUp' && isOpen) {
      e.preventDefault();
      const currentIndex = options.findIndex((opt) => opt.id === value);
      const prevIndex = (currentIndex - 1 + options.length) % options.length;
      onChange(options[prevIndex].id);
    }
  };

  const getGenderBadge = (gender: 'female' | 'male' | 'neutral') => {
    switch (gender) {
      case 'female':
        return <span className="voice-gender-tag voice-gender-tag--female">Femenina</span>;
      case 'male':
        return <span className="voice-gender-tag voice-gender-tag--male">Masculina</span>;
      case 'neutral':
        return <span className="voice-gender-tag voice-gender-tag--neutral">Neutra</span>;
    }
  };

  return (
    <div
      className={`glass-select-container voice-select-container ${compact ? 'voice-select--compact' : ''} ${isOpen ? 'is-open' : ''} ${disabled ? 'is-disabled' : ''}`}
      ref={dropdownRef}
      id={id}
    >
      <button
        type="button"
        className="glass-select-trigger voice-select-trigger"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className="glass-select-value voice-select-value">
          <Volume2 size={16} className="voice-select-icon" />
          <span className="voice-select-title">{selectedOption.name}</span>
          {!compact && getGenderBadge(selectedOption.gender)}
        </span>

        <span className={`glass-select-arrow ${isOpen ? 'is-rotated' : ''}`}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square">
            <path d="M2 4L6 8L10 4" />
          </svg>
        </span>
      </button>

      {isOpen && (
        <ul className="glass-select-menu voice-select-menu" role="listbox">
          {options.map((option) => {
            const isSelected = option.id === value;
            return (
              <li
                key={option.id}
                role="option"
                aria-selected={isSelected}
                className={`glass-select-option voice-select-option ${isSelected ? 'is-selected' : ''}`}
                onClick={() => {
                  onChange(option.id);
                  setIsOpen(false);
                }}
              >
                <div className="voice-option-details">
                  <div className="voice-option-head">
                    <span className="voice-option-name">{option.name}</span>
                    {getGenderBadge(option.gender)}
                  </div>
                  <span className="voice-option-desc">{option.description}</span>
                </div>
                {isSelected && (
                  <Check size={16} className="glass-select-check" strokeWidth={2.5} />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export default VoiceSelect;
