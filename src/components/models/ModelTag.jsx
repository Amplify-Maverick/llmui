import "./ModelTag.css";

export default function ModelTag({ model, onClick }) {
  return (
    <span
      className="model-tag"
      onClick={() => onClick(model)}
      title={`Click to install ${model}`}
    >
      {model}
    </span>
  );
}
