import { useGlobeStore } from '../state/useGlobeStore';
import type { BasemapId } from '@terra-pulse/schema';
import styles from './BasemapToggle.module.css';

const OPTIONS: { id: BasemapId; label: string }[] = [
  { id: 'osm', label: 'Basic' },
  { id: 'satellite', label: 'Satellite' },
];

export function BasemapToggle() {
  const activeBasemap = useGlobeStore((state) => state.activeBasemap);
  const setActiveBasemap = useGlobeStore((state) => state.setActiveBasemap);

  return (
    <div id="basemap-toggle" className={styles.toggleGroup}>
      {OPTIONS.map((option) => (
        <button
          key={option.id}
          id={`basemap-toggle-${option.id}`}
          type="button"
          onClick={() => setActiveBasemap(option.id)}
          className={
            activeBasemap === option.id
              ? `${styles.toggleButton} ${styles.toggleButtonActive}`
              : styles.toggleButton
          }
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
