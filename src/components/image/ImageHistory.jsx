import { useImageStore } from "../../stores/imageStore.js";
import AuthImage from "./AuthImage.jsx";
import "./ImageHistory.css";

export default function ImageHistory() {
  const {
    generations,
    generationsTotal,
    generationsPage,
    isLoadingHistory,
    currentGenerationId,
    selectGeneration,
    deleteGeneration,
    loadHistory,
    getImageUrl,
  } = useImageStore();

  const totalPages = Math.ceil(generationsTotal / 20);

  if (generations.length === 0 && !isLoadingHistory) {
    return (
      <div className="img-history-empty">
        <span className="img-history-empty-text">No generation history yet</span>
      </div>
    );
  }

  return (
    <div className="img-history">
      <div className="img-history-scroll">
        {generations.map((gen) => (
          <button
            key={gen.id}
            className={`img-history-thumb ${gen.id === currentGenerationId ? "active" : ""}`}
            onClick={() => selectGeneration(gen.id)}
            title={gen.prompt?.slice(0, 80) || "Generation"}
          >
            {gen.first_image_id ? (
              <AuthImage
                src={getImageUrl(gen.id, gen.first_image_id)}
                alt=""
                className="img-history-thumb-img"
              />
            ) : (
              <div className="img-history-thumb-placeholder">?</div>
            )}
            <button
              className="img-history-delete"
              onClick={(e) => {
                e.stopPropagation();
                deleteGeneration(gen.id);
              }}
              title="Delete"
            >
              ×
            </button>
          </button>
        ))}
      </div>

      {totalPages > 1 && (
        <div className="img-history-pager">
          <button
            className="img-history-page-btn"
            disabled={generationsPage <= 1}
            onClick={() => loadHistory(generationsPage - 1)}
          >
            ←
          </button>
          <span className="img-history-page-text">
            {generationsPage} / {totalPages}
          </span>
          <button
            className="img-history-page-btn"
            disabled={generationsPage >= totalPages}
            onClick={() => loadHistory(generationsPage + 1)}
          >
            →
          </button>
        </div>
      )}
    </div>
  );
}
