import { useState } from "react";

const baseStyle = {
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: "8px",
  padding: "10px 12px",
  color: "#e8e8f0",
  fontSize: "14px",
  fontFamily: "'DM Mono', monospace",
  outline: "none",
  width: "100%",
  transition: "border-color 0.2s ease, background 0.2s ease",
};

const focusStyle = {
  borderColor: "rgba(110, 231, 183, 0.5)",
  background: "rgba(255,255,255,0.08)",
};

export default function Input({
  type = "text",
  value,
  onChange,
  placeholder,
  disabled = false,
  style = {},
  ...props
}) {
  const [isFocused, setIsFocused] = useState(false);

  const computedStyle = {
    ...baseStyle,
    ...(isFocused ? focusStyle : {}),
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? "not-allowed" : "text",
    ...style,
  };

  return (
    <input
      type={type}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      disabled={disabled}
      style={computedStyle}
      onFocus={() => setIsFocused(true)}
      onBlur={() => setIsFocused(false)}
      {...props}
    />
  );
}

export function TextArea({
  value,
  onChange,
  placeholder,
  disabled = false,
  rows = 4,
  style = {},
  ...props
}) {
  const [isFocused, setIsFocused] = useState(false);

  const computedStyle = {
    ...baseStyle,
    ...(isFocused ? focusStyle : {}),
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? "not-allowed" : "text",
    resize: "vertical",
    minHeight: "80px",
    ...style,
  };

  return (
    <textarea
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      disabled={disabled}
      rows={rows}
      style={computedStyle}
      onFocus={() => setIsFocused(true)}
      onBlur={() => setIsFocused(false)}
      {...props}
    />
  );
}

const optionStyle = {
  background: "#1a1a24",
  color: "#e8e8f0",
};

export function Select({
  value,
  onChange,
  options = [],
  placeholder,
  disabled = false,
  style = {},
  ...props
}) {
  const [isFocused, setIsFocused] = useState(false);

  const computedStyle = {
    ...baseStyle,
    ...(isFocused ? focusStyle : {}),
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? "not-allowed" : "pointer",
    ...style,
  };

  return (
    <select
      value={value}
      onChange={onChange}
      disabled={disabled}
      style={computedStyle}
      onFocus={() => setIsFocused(true)}
      onBlur={() => setIsFocused(false)}
      {...props}
    >
      {placeholder && (
        <option value="" disabled style={optionStyle}>
          {placeholder}
        </option>
      )}
      {options.map((opt) => (
        <option key={opt.value} value={opt.value} style={optionStyle}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}
