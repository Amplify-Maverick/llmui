import "./Input.css";

export default function Input({
  type = "text",
  value,
  onChange,
  placeholder,
  disabled = false,
  className = "",
  style = {},
  ...props
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      disabled={disabled}
      className={`input ${className}`}
      style={style}
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
  className = "",
  style = {},
  ...props
}) {
  return (
    <textarea
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      disabled={disabled}
      rows={rows}
      className={`textarea ${className}`}
      style={style}
      {...props}
    />
  );
}

export function Select({
  value,
  onChange,
  options = [],
  placeholder,
  disabled = false,
  className = "",
  style = {},
  ...props
}) {
  return (
    <select
      value={value}
      onChange={onChange}
      disabled={disabled}
      className={`select ${className}`}
      style={style}
      {...props}
    >
      {placeholder && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}
