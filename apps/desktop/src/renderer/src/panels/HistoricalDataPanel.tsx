import { CollapsibleSection } from './CollapsibleSection';
import { ArchivePanel } from './ArchivePanel';
import { SpaceWeatherArchive } from './SpaceWeatherArchive';
import { DonkiArchive } from './DonkiArchive';
import { HISTORICAL_DATA_SECTION_ID } from '../state/useGlobeStore';
import styles from './HistoricalDataPanel.module.css';

/**
 * The three historical backfill controls — earthquakes, geomagnetic index
 * history, solar events — under one disclosure.
 *
 * They used to be three separate cards stacked in the left column, each
 * always visible. Grouped here for the same reason the inspector's sections
 * are collapsible: these are look-once-then-forget controls (download it,
 * check back on progress occasionally), not something that needs to occupy
 * vertical space beside the range controls permanently.
 *
 * **One toggle for all three, not three independent ones.** They answer
 * related questions (what history has this app downloaded) rather than
 * different ones, unlike the inspector's four sections — so unlike those,
 * comparing two of these at once isn't a real use case, and one disclosure
 * is simpler than three.
 *
 * Starts **open**, not collapsed — see `HISTORICAL_DATA_SECTION_ID`'s own
 * note in `useGlobeStore.ts` for why that didn't need a new prop on
 * `CollapsibleSection`. The three children stay functionally independent:
 * separate downloads, separate costs, separate failure states, each still
 * rendering its own heading and status line — this only removes their
 * individual outer card chrome, now owned by `.card` here.
 */
export function HistoricalDataPanel() {
  return (
    <div className={styles.card}>
      <CollapsibleSection id={HISTORICAL_DATA_SECTION_ID} title="Historical data">
        <div className={styles.stack}>
          <ArchivePanel />
          <SpaceWeatherArchive />
          <DonkiArchive />
        </div>
      </CollapsibleSection>
    </div>
  );
}
