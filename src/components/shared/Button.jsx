import "./Button.css";

export default function Button({
  children,
  variant = "primary",
  disabled = false,
  onClick,
  className = "",
  style = {},
  ...props
}) {
  return (
    <button
      className={`btn btn-${variant} ${className}`}
      disabled={disabled}
      onClick={onClick}
      style={style}
      {...props}
    >
      {children}
    </button>
  );
}
