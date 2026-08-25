/**
 * Paseo HarmonyOS — EntryAbility
 *
 * Main application entry point. Manages the application lifecycle and
 * provides the global PaseoClientLifecycle singleton via a static accessor.
 *
 * This is a Stage Model Ability. The UI is loaded from pages/connect-page
 * as the initial route.
 */

import { UIAbility } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { PaseoClientLifecycle } from '../client/client-lifecycle';
import { preferences } from '@kit.ArkData';

export class EntryAbility extends UIAbility {
  /** Global singleton — one daemon client per app process. */
  static paseoClient: PaseoClientLifecycle = new PaseoClientLifecycle();

  onCreate(): void {
    // Initialize any app-level services here.
    // The PaseoClientLifecycle is lazily connected when the user
    // navigates to the connect page.
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    // Set the initial page to load
    windowStage.loadContent('pages/connect-page', (err: BusinessError) => {
      if (err && err.code !== 0) {
        console.error('Paseo: failed to load connect-page:', JSON.stringify(err));
        return;
      }
      console.info('[PASEO] EntryAbility: connect-page loaded');
    });
  }

  onDestroy(): void {
    // Clean up the daemon connection when the app is terminated
    EntryAbility.paseoClient.disconnect();
  }
}

export default EntryAbility;
