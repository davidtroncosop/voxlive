import React, { useState, useRef, useEffect } from 'react';
import type { Language } from '../types';

interface GlassSelectProps {
  value: string;
  options: Language[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  id?: string;
}

export const GlassSelect: React.FC<GlassSelectProps> = ({
  value,
  options,
  onChange,
  disabled = false,
  placeholder = 'Seleccionar idioma',
  id,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find((opt) => opt.code === value);

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
      const currentIndex = options.findIndex((opt) => opt.code === value);
      const nextIndex = (currentIndex + 1) % options.length;
      onChange(options[nextIndex].code);
    } else if (e.key === 'ArrowUp' && isOpen) {
      e.preventDefault();
      const currentIndex = options.findIndex((opt) => opt.code === value);
      const prevIndex = (currentIndex - 1 + options.length) % options.length;
      onChange(options[prevIndex].code);
    }
  };

  return (
    <div 
      className={`glass-select-container ${isOpen ? 'is-open' : ''} ${disabled ? 'is-disabled' : ''}`}
      ref={dropdownRef}
      id={id}
    >
      <button
        type="button"
        className="glass-select-trigger"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className="glass-select-value">
          {selectedOption ? (
            <>
              <span className="glass-select-flag" aria-hidden="true">{selectedOption.flag}</span>
              <span className="glass-select-name">{selectedOption.name}</span>
            </>
          ) : (
            <span className="glass-select-placeholder">{placeholder}</span>
          )}
        </span>

        <span className={`glass-select-arrow ${isOpen ? 'is-rotated' : ''}`}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square">
            <path d="M2 4L6 8L10 4" />
          </svg>
        </span>
      </button>

      {isOpen && (
        <ul className="glass-select-menu" role="listbox">
          {options.map((option) => {
            const isSelected = option.code === value;
            return (
              <li
                key={option.code}
                role="option"
                aria-selected={isSelected}
                className={`glass-select-option ${isSelected ? 'is-selected' : ''}`}
                onClick={() => {
                  onChange(option.code);
                  setIsOpen(false);
                }}
              >
                <div className="glass-select-option-content">
                  <span className="glass-select-flag" aria-hidden="true">{option.flag}</span>
                  <span className="glass-select-name">{option.name}</span>
                </div>
                {isSelected && (
                  <svg className="glass-select-check" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="square">
                    <path d="M2 7.5L5.5 11L12 3" />
                  </svg>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export default GlassSelect;
