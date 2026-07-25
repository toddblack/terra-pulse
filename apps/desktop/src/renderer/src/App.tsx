import { CesiumViewer } from './globe/CesiumViewer';
import { BasemapToggle } from './panels/BasemapToggle';
import styles from './App.module.css';

export default function App() {
  return (
    <div id="app-shell" className={styles.appShell}>
      <CesiumViewer />
      <BasemapToggle />
    </div>
  );
}
