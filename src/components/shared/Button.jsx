import { useState } from "react";

const baseStyle = {
  borderRadius: "8px",
  padding: "10px 20px",
  fontSize: "14px",
  fontFamily: "'DM Sans', sans-serif",
  fontWeight: "500",
  cursor: "pointer",
  transition: "all 0.2s ease",
  border: "1px solid",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "8px",
};

const variants = {
  primary: {
    background: "rgba(110, 231, 183, 0.15)",
    borderColor: "rgba(110, 231, 183, 0.3)",
    color: "#6ee7b7",
    hoverBg: "rgba(110, 231, 183, 0.25)",
    hoverBorder: "rgba(110, 231, 183, 0.5)",
  },
  secondary: {
    background: "rgba(96, 165, 250, 0.15)",
    borderColor: "rgba(96, 165, 250, 0.3)",
    color: "#60a5fa",
    hoverBg: "rgba(96, 165, 250, 0.25)",
    hoverBorder: "rgba(96, 165, 250, 0.5)",
  },
  danger: {
    background: "rgba(255, 107, 107, 0.15)",
    borderColor: "rgba(255, 107, 107, 0.3)",
    color: "#ff6b6b",
    hoverBg: "rgba(255, 107, 107, 0.25)",
    hoverBorder: "rgba(255, 107, 107, 0.5)",
  },
  ghost: {
    background: "transparent",
    borderColor: "rgba(255, 255, 255, 0.1)",
    color: "#8a8a9a",
    hoverBg: "rgba(255, 255, 255, 0.05)",
    hoverBorder: "rgba(255, 255, 255, 0.2)",
  },
};

export default function Button({
  children,
  variant = "primary",
  disabled = false,
  onClick,
  style = {},
  ...props
}) {
  const [isHovered, setIsHovered] = useState(false);
  const v = variants[variant] || variants.primary;

  const computedStyle = {
    ...baseStyle,
    background: isHovered && !disabled ? v.hoverBg : v.background,
    borderColor: isHovered && !disabled ? v.hoverBorder : v.borderColor,
    color: v.color,
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? "not-allowed" : "pointer",
    ...style,
  };

  return (
    <button
      style={computedStyle}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      {...props}
    >
      {children}
    </button>
  );
}
