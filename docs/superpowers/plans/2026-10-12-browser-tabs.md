# Navigateur intégré à onglets — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, or superpowers:subagent-driven-development if the user selects delegated execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Donner au navigateur desktop de Paseo une gestion des onglets prévisible et une navigation fluide, avec conversation et page côte à côte ou page agrandie.

**Architecture:** Conserver les pages Electron résidentes et les identifiants `browserId`. Regrouper les nouvelles ouvertures implicites dans un panneau navigateur du workspace, en réutilisant le layout, la rangée d’onglets, le glisser-déposer et la maximisation existants. Les onglets restent des `WorkspaceTab` : aucun second registre d’onglets ni nouveau moteur navigateur.

**Tech Stack:** Electron 44.2.0, React 19, React Native Web, Zustand, Unistyles, composants UI et système de raccourcis du dépôt ; Vitest, Playwright et harness Electron existants. Aucune dépendance ajoutée.

**Spec:** La section [Conception et périmètre](#conception-et-périmètre) de ce document formalise la direction acceptée dans la conversation du 12 octobre 2026. Les choix détaillés ci-dessous constituent la proposition à relire avant exécution.

**Statut:** Plan uniquement, relu contre le code du checkout le 12 octobre 2026. Aucun changement produit, benchmark ou contrôle visuel effectué pour rédiger ou corriger ce document. L’exécution reste une demande distincte.

## Conception et périmètre

### Expérience visée

La référence est le navigateur intégré de ChatGPT, en particulier sa fluidité et ses onglets. DeepSeek est hors du sujet. La [documentation officielle ChatGPT](https://learn.chatgpt.com/docs/browser) confirme les vues partagée et agrandie, les onglets, la barre d’adresse et les annotations ; elle ne documente pas son architecture interne. Ce plan ne suppose pas que ChatGPT utilise les mêmes composants que Paseo.

Disposition proposée :

```text
┌──────────────────── workspace ──────────────────────────┐
│ Conversation                  │ Site A │ Site B │ + │ ⛶ │
│                               ├─────────────────────────┤
│ Messages                      │ ← → ⟳  Adresse     ⋯    │
│                               ├─────────────────────────┤
│                               │                         │
│                               │ Page active             │
│ Composer                      │                         │
└───────────────────────────────┴─────────────────────────┘
```

Le dessin exprime la hiérarchie, pas un rendu à reproduire pixel par pixel. Conserver les tokens, la densité et les composants de Paseo.

### Première livraison

1. Un panneau navigateur par défaut à droite du travail courant ; il possède une rangée d’onglets et une barre de navigation pour la page active.
2. Création, sélection, fermeture, réorganisation, défilement de la rangée et accès à tous les onglets depuis un menu.
3. Conservation de la page vivante lors des changements d’onglet, de workspace, du masquage et de la maximisation.
4. Passage partagé/agrandi qui conserve les proportions du layout et l’état de la conversation.
5. Ouvertures de l’agent en arrière-plan, sans changement de focus ni apparition imposée du panneau.
6. Réouverture du dernier onglet fermé par l’utilisateur, dans le workspace concerné, pendant la session de l’application.
7. Mesures avant/après sur des pages locales déterministes et preuves Electron des comportements.

La barre d’adresse conserve la normalisation et les restrictions existantes. Un nouvel onglet manuel utilise une page blanche locale au navigateur, sans requête vers `example.com`, et place le focus dans l’adresse. `about:blank` est un cas interne précis ; ne pas autoriser arbitrairement `file:`, `javascript:` ou les autres protocoles. Les arguments et valeurs par défaut publics de `browser_new_tab` restent inchangés.

### Règles d’onglets et de focus

| Action                                 | Placement                                                        | Sélection et focus                                                                                                             |
| -------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Ouvrir une URL depuis la conversation  | Panneau navigateur par défaut                                    | Révéler et sélectionner la nouvelle page                                                                                       |
| `+` dans le panneau navigateur         | Même panneau, après l’onglet actif                               | Nouvelle page blanche, adresse sélectionnée                                                                                    |
| Choix explicite dans un autre panneau  | Destination explicitement choisie                                | Respecter le placement utilisateur                                                                                             |
| Lien ouvrant un onglet depuis une page | Après l’onglet source, dans son panneau                          | Conserver la politique actuelle de l’événement Electron ; ne pas inventer une distinction clic/modificateur absente du payload |
| `browser_new_tab` de l’agent           | Panneau navigateur par défaut                                    | Arrière-plan ; ne pas changer la page visible, le focus ou la largeur de la conversation                                       |
| Fermer un onglet inactif               | Retirer seulement cet onglet                                     | Conserver la page active                                                                                                       |
| Fermer l’onglet actif                  | Même panneau                                                     | Sélectionner le voisin de droite, sinon celui de gauche                                                                        |
| Fermer le dernier onglet               | Détruire sa page                                                 | Refermer le panneau navigateur dédié si une autre surface visible reste ; sinon conserver le lanceur vide existant             |
| Masquer le navigateur                  | Conserver panneau et onglets                                     | Rendre le focus au panneau de travail visible ; ne fermer aucune page                                                          |
| Agrandir puis restaurer                | Même panneau, mêmes pages                                        | Retrouver les proportions et la sélection précédentes                                                                          |
| Réouvrir le dernier onglet fermé       | Ancien panneau s’il existe et convient, sinon panneau navigateur | Créer une nouvelle page sur sa dernière URL ; sélectionner cette page                                                          |

Masquer n’est pas fermer. La fermeture libère la page Electron et son enregistrement. La réouverture restaure l’URL et le viewport, mais ne promet ni historique précédent, ni scroll, ni contenu de formulaire après destruction. Les fermetures automatiques de preview et celles demandées par l’agent n’écrasent pas le dernier onglet fermé manuellement.

Un onglet existant explicitement déplacé reste à sa place. Les anciens layouts ne sont pas réorganisés au démarrage. Pour les nouvelles ouvertures implicites, réutiliser le panneau navigateur mémorisé s’il ne contient que des pages navigateur ou son lanceur vide. Sinon choisir un panneau ordinaire déjà composé uniquement de pages navigateur, puis créer un panneau à droite si nécessaire. Explorer reste exclu de cette sélection, même s’il contient une page navigateur.

Une ouverture en arrière-plan préserve la visibilité d’un panneau déjà présent : elle ne révèle pas un panneau masqué et ne masque pas un panneau visible. Seul un panneau nouvellement créé par cette ouverture démarre masqué. Un panneau rendu mixte par l’utilisateur retrouve le chrome générique ; il n’est ni vidé ni masqué automatiquement. Le toggle navigateur ne le masque pas, y compris avant qu’une nouvelle ouverture ait remplacé sa référence mémorisée. La dernière surface de travail signifie le dernier panneau ordinaire visible ; Explorer ne peut pas remplacer le canvas workspace.

### Conservation et durée de vie

- `WorkspaceLayout` / le panel store existant possèdent l’ordre, les cibles et la sélection.
- `useBrowserStore` possède URL, titre, favicon et viewport.
- `resident-webviews.ts` possède les pages Electron vivantes. Masquer ou déplacer une page ne change pas son `WebContents`.
- Ajouter seulement `browserPaneIdByWorkspace` au layout store pour retrouver le panneau par défaut. Le champ persisté est optionnel ; son absence ne doit pas invalider les anciens layouts.
- Le booléen `hidden` existant représente le masquage. La maximisation reste un état de présentation du `SplitContainer`.
- Conserver en mémoire un seul descriptif d’onglet fermé par workspace, sans persister de formulaire ou de contenu de page. Supprimer ce descriptif au purge du workspace.
- Au redémarrage complet, restaurer les URLs, l’ordre et la sélection comme état de navigation ; les pages se rechargent. La continuité du DOM est garantie pendant la session vivante, pas après arrêt du processus.

### Hors périmètre

Streaming vers mobile/web, remplacement par Playwright ou un autre moteur, extension Chrome, nouvelle politique de permissions, synchronisation des profils, historique de navigation complet, favoris, onglets épinglés, groupes nommés, curseur d’agent animé et suivi automatique de son onglet. Le bouton « suivre l’agent » évoqué dans l’analyse initiale est reporté : il nécessite une association fiable entre activité et onglet, au-delà du besoin de fluidité validé.

## Global Constraints

- Conserver Electron 44.2.0 et les dépendances déjà installées ; aucune dépendance ajoutée.
- Fonctionnalité ciblée Electron desktop ; garder les comportements web, iOS et Android existants.
- Préférer les fichiers `.electron.tsx` pour le code exclusivement Electron ; DOM uniquement en environnement web.
- Aucun changement de RPC, de `browserId` public, de profil Chromium ou de partition de cookies.
- Aucun redémarrage du daemon principal sur le port 6767.
- Réutiliser les composants de tabs, menus, boutons, focus et layout ; aucune seconde source de vérité pour les onglets.
- Conserver les validations URL, l’isolation des workspaces et le nettoyage des ressources.
- Pas de `useUnistyles()` ni de nouveaux `onPointerEnter`/`onPointerLeave` ; respecter les instructions AGENTS et les patterns autorisés.
- Tests locaux limités aux fichiers modifiés, avec `--bail=1` ; aucune suite complète locale.
- Exécuter typecheck et lint après les changements ; utiliser les scripts npm pour lint et formatage.
- Les captures d’une vérification visuelle doivent figurer intégrées en Markdown dans le compte rendu final, avec une légende pour chaque état distinct vérifié.
- Le checkout contient déjà des modifications d’autres tâches : ne pas les réécrire, les inclure dans un commit ou les attribuer à ce plan.

## Review Focus

1. Premier onglet créé par l’agent pendant une saisie : aucune perte de focus, sélection ou espace disponible. Tests tâches 2 et 3.
2. Ancien layout, identifiant de panneau périmé, onglets déplacés ou limite de profondeur atteinte : aucune perte de données ni déplacement implicite. Tests tâches 2 et 3.
3. Saisie non envoyée, connexion et scroll après changement d’onglet, masquage ou maximisation : même page Electron. Tests tâches 1 et 5.
4. Fermeture d’une page inactive ou dernier onglet alors qu’une commande agent arrive : nettoyer une seule fois, ne pas recréer la page fermée et retourner l’erreur existante. Tests tâches 3 et 6.
5. Rangée saturée, titre/favicon changeant et interaction clavier/IME : onglet actif accessible, géométrie stable et saisie isolée du composer. Tests tâches 4 et 7.

## État du code et carte des modifications

| Fichier / groupe                                                                                                                            | Rôle et intervention                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `packages/app/src/stores/workspace-layout-store.ts` et `workspace-layout-storage.ts`                                                        | Panneau navigateur mémorisé, ouverture/masquage, nettoyage des références et lecture des anciens layouts                      |
| `packages/app/src/stores/workspace-layout-actions.ts`                                                                                       | Réutiliser split et masquage ; préserver le placement explicite, l’état preview et le choix du voisin à la fermeture          |
| `packages/app/src/workspace-tabs/browser.ts` — nouveau                                                                                      | Point d’entrée de création/ouverture des pages, placement et descriptif du dernier onglet fermé                               |
| `packages/app/src/screens/workspace/workspace-screen.tsx`                                                                                   | Brancher créations, URL, fermeture, toggle du navigateur et raccourcis                                                        |
| `packages/app/src/screens/workspace/workspace-desktop-tabs-row.tsx`                                                                         | Variante navigateur de la rangée existante, bouton `+` direct, liste des onglets et libellés accessibles                      |
| `packages/app/src/screens/workspace/workspace-tab-layout.ts`                                                                                | Réutiliser le calcul de largeur ; fournir les métriques de la variante navigateur                                             |
| `packages/app/src/components/split-container.tsx`                                                                                           | Présentation navigateur, masquage, agrandissement/restauration et intégration DnD                                             |
| `packages/app/src/desktop/browser/panel.tsx`, `pane/index.electron.tsx` et `resident-webviews.ts`                                           | Libellé de la page blanche, demande initiale de focus, barre d’adresse et continuité ; conserver le parking actuel            |
| `packages/app/src/desktop/browser/new-tab-requests/index.ts`                                                                                | Transmettre le contexte de l’onglet source au point d’ouverture                                                               |
| `packages/app/src/desktop/browser/automation/handler.ts`                                                                                    | Ouverture en arrière-plan et fermeture via les mêmes règles de cycle de vie                                                   |
| `packages/app/src/workspace-tabs/dev-preview.ts`                                                                                            | Conserver unicité par script, métadonnées de preview et placement explicite existant                                          |
| `packages/app/src/plugins/host-navigation.ts` et `host-navigation-model.ts`                                                                 | Respecter host/workspace demandé et chemin de navigation existant lors d’une ouverture navigateur                             |
| `packages/app/src/keyboard/actions.ts`, `keyboard/keyboard-shortcuts.ts`, `hooks/use-keyboard-shortcuts.ts`, `desktop/browser/shortcuts.ts` | Action configurable et transmission des raccourcis à la page, sans écouteur global supplémentaire                             |
| `packages/app/src/workspace/use-workspace-archive.ts`                                                                                       | Nettoyage des pages avant la purge du layout ; ne pas changer la décision d’archivage ni le cycle de vie des agents/terminaux |
| `packages/app/src/i18n/resources/*.ts` et `resources.test.ts`                                                                               | Libellés et parité des clés pour toutes les langues du dépôt                                                                  |
| `packages/desktop/e2e/browser-tabs.e2e.mjs`                                                                                                 | Parcours Electron, conservation du `WebContents`, captures, latences et mémoire                                               |

Relire avant exécution : `docs/design.md`, `docs/explorer-sidebar.md`, `docs/expo-router.md`, `docs/browser-capture-harness.md`, `docs/testing.md`, `docs/qa.md`, `docs/unistyles.md`, `docs/i18n.md` et les instructions locales actualisées.

## Tâche 1 — Mesurer le comportement actuel et fixer les preuves

**Fichiers :** modifier `packages/desktop/e2e/browser-tabs.e2e.mjs`. Réutiliser ses pages HTTP locales, son daemon isolé, ses assertions, sa connexion CDP et son répertoire d’artefacts. Ne pas créer un script ou une CI dédiés.

**Interfaces :** utiliser les outils existants `browser_new_tab`, `browser_evaluate`, `browser_list_tabs`, les sélecteurs `workspace-tab-browser_${browserId}` et l’identité `WebContents` déjà mesurée dans ce parcours. Produire `browser-tabs-baseline.json` puis `browser-tabs-after.json` dans le dossier d’artefacts.

- [ ] Ajouter une page fixture avec champ texte, contenu assez long pour scroller, compteur de chargements et marqueur visuel distinct par onglet. Conserver les contrôles utilisés par le parcours actuel. Ne charger aucune ressource distante. Le compteur doit survivre à un reload : une valeur initialisée dans `window` à chaque chargement ne détecte pas une recréation. Utiliser un compteur `sessionStorage` propre à la page et un compteur HTTP par identifiant de fixture pour détecter aussi un nouveau guest.
- [ ] Ajouter une vérification de continuité à deux onglets : saisir `brouillon conservé`, scroller à une position connue, basculer vingt fois et comparer `WebContents`, valeur du champ, scroll et compteur.

```js
assert(after.webContentsId === before.webContentsId, "Tab switch recreated the guest");
assert(after.inputValue === "brouillon conservé", "Tab switch lost the draft");
assert(after.scrollY === before.scrollY, "Tab switch lost scroll position");
assert(after.loadCount === before.loadCount, "Tab switch reloaded the page");
```

- [ ] Mesurer 30 changements d’onglet après 5 changements de chauffe, avec 2 puis 10 onglets. Horodater le clic dans le renderer ; ne pas inclure les auto-waits Playwright ou les allers-retours MCP dans la latence d’affichage. Mesurer séparément le retour visuel de sélection et la présentation de la page ; une mise à jour du store ou d’ARIA ne prouve pas qu’un pixel est affiché.
- [ ] Pour la sélection et la page, corréler événements renderer et présentation avec une trace Chromium/compositeur ; compléter par une courte capture vidéo des changements. Si la trace ne permet pas d’attribuer une frame présentée au bon guest ou au chrome hôte, publier respectivement « présentation demandée » ou « sélection appliquée ». Ne pas comparer ces mesures aux cibles de peinture de la tâche 7.
- [ ] Relever mémoire des processus renderer au repos, avec 10 pages, puis après fermeture de 9 pages et 10 secondes de stabilisation. Identifier cette cohorte par ses 10 browserIds, séparément des autres pages du parcours. Associer les guests à leurs `WebContents` et PID ; séparer le renderer hôte et dédupliquer les PID partagés. Garder les résultats bruts, version Electron/Chromium, machine, révision source et mode de build. Ne pas attribuer la mémoire totale de l’app aux seuls onglets.
- [ ] Ajouter au parcours existant `PASEO_DESKTOP_BROWSER_E2E_PHASE=baseline|after`, avec `after` par défaut. La phase `baseline` exécute les invariants actuels et le protocole de mesure, sans assertions sur le chrome encore absent ; elle écrit `browser-tabs-baseline.json`. La phase `after` active les nouveaux scénarios et écrit `browser-tabs-after.json`. Les deux phases réutilisent les mêmes fixtures et mesures.
- [ ] Exécuter une seule fois le parcours existant et sauvegarder la baseline. Les invariants déjà corrects doivent rester verts ; les nouveaux comportements sont introduits par les tests des tâches suivantes.

```bash
PASEO_DESKTOP_BROWSER_E2E_PHASE=baseline PASEO_DESKTOP_BROWSER_E2E_ARTIFACT_DIR="$PWD/packages/desktop/capture-harness/out/browser-tabs-baseline" npm run test:e2e:browser-tabs --workspace=@getpaseo/desktop
```

Résultat attendu : les invariants actuels passent et les mesures brutes, trace et vidéo sont enregistrées. Aucun seuil de latence n’est un gate de cette baseline. Noter la révision et les modifications locales qui composent l’état mesuré ; si une baseline de production devient nécessaire à la tâche 7, la reconstruire depuis cet état avec l’instrumentation de cette tâche, dans un checkout isolé.

**Livrable :** une baseline reproductible, sans affirmation de performance avant mesure. Si elle révèle une régression existante, la noter séparément avant de modifier son mécanisme.

## Tâche 2 — Donner un propriétaire au panneau navigateur

**Fichiers :** modifier les trois fichiers `workspace-layout-{store,storage,actions}.ts`, étendre `workspace-layout-store.test.ts`. Ne pas créer de nouveau type de cible dans le protocole ou de nouveau `PaneHost`.

**Interfaces nouvelles dans `WorkspaceLayoutStore` :**

```ts
browserPaneIdByWorkspace: Record<string, string | null>;
ensureBrowserPane: (workspaceKey: string, options: { reveal: boolean }) => string | null;
hideBrowserPane: (workspaceKey: string) => void;
```

- [ ] Ajouter un test rouge dans la suite layout existante pour le premier `ensureBrowserPane(key, { reveal: false })` : nouveau panneau masqué, panneau conversation toujours visible et même `focusedPaneId`.
- [ ] Exécuter le test avant implémentation : `npx vitest run src/stores/workspace-layout-store.test.ts --bail=1 -t "creates a hidden browser pane without changing workspace focus"`. Résultat attendu : échec sur l’absence de `ensureBrowserPane`, puis passage après implémentation.
- [ ] Implémenter avec `splitWorkspaceRootRightInLayout`, `setPaneHiddenInLayout`, `findPaneById` et les normalisations existantes. Appliquer création, masquage et sélection précédente dans une seule mise à jour Zustand ; aucun état intermédiaire visible. `collectAllPanes` exclut les panneaux masqués : retrouver le panneau mémorisé avec `findPaneById`. Parcourir le tree complet pour retrouver aussi un autre panneau navigateur masqué. `collectAllTabs` inclut déjà les onglets masqués.
- [ ] Tester puis implémenter les appels répétés : ils rendent le même panneau ; `reveal: true` le révèle sans dupliquer les pages ; `reveal: false` conserve sa visibilité actuelle, les tabs sélectionnés et `focusRestorationByWorkspace` ; `hideBrowserPane` le masque sans supprimer ses onglets. Le masquage ignore une référence périmée ou devenue mixte. Exclure Explorer de la destination et du toggle.
- [ ] Refuser de masquer le dernier panneau ordinaire visible, même si Explorer est visible. `setPaneHiddenInLayout` ne vérifie aujourd’hui que le nombre total de panneaux visibles ; combiner cette opération avec le garde ordinaire de `canDismissPaneInLayout`. Tester le navigateur seul avec Explorer ouvert. Sortir de la maximisation au masquage à la tâche 5.
- [ ] Vérifier les anciens layouts et le champ optionnel persisté. Ajouter le champ à la lecture, au `partialize`, au merge, au purge et aux chemins qui réconcilient les références après fermeture/déplacement.
- [ ] Tester une référence périmée, un panneau devenu mixte et un panneau déjà supprimé. Préserver tout le contenu et choisir une nouvelle destination compatible selon la conception.
- [ ] Tester la limite `MAX_TREE_DEPTH` : `ensureBrowserPane` retourne `null`, ne modifie pas le layout, et le point d’ouverture affiche/retourne une erreur à la tâche 3.
- [ ] Épingler ces attentes dans les tests de store existants après leur initialisation de fixture :

```ts
const store = createWorkspaceLayoutStore(createDeterministicWorkspaceLayoutIds());
const workspaceKey = `${SERVER_ID}:${WORKSPACE_ID}`;
store.getState().openTab({
  workspaceKey,
  target: { kind: "agent", agentId: "browser-pane-conversation" },
  intent: "reveal",
});
const before = store.getState().layoutByWorkspace[workspaceKey];
const paneId = store.getState().ensureBrowserPane(workspaceKey, { reveal: false });
expect(paneId).not.toBeNull();
const state = store.getState();
expect(state.layoutByWorkspace[workspaceKey].focusedPaneId).toBe(before.focusedPaneId);
expect(findPaneById(state.layoutByWorkspace[workspaceKey].root, paneId!)?.hidden).toBe(true);
expect(state.ensureBrowserPane(workspaceKey, { reveal: false })).toBe(paneId);
```

- [ ] Exécuter depuis `packages/app` : `npx vitest run src/stores/workspace-layout-store.test.ts --bail=1`, puis les contrôles communs. Résultat attendu : suite verte, y compris relecture des blobs anciens, panneau mixte, visibilité conservée et refus à la profondeur maximale sans mutation du layout.

**Livrable :** panneau retrouvable, masquable et compatible avec les layouts existants, sans ouverture forcée par l’agent.

## Tâche 3 — Unifier les ouvertures et conserver le contrat agent

**Fichiers :** créer `workspace-tabs/browser.ts` ; modifier `workspace-screen.tsx`, `workspace-layout-store.ts`, `workspace-layout-actions.ts`, `desktop/browser/automation/handler.ts`, `desktop/browser/new-tab-requests/index.ts`, `workspace-tabs/dev-preview.ts`, les deux fichiers de navigation des plugins et leurs tests existants. Étendre les suites `automation/handler.test.ts`, `new-tab-requests/index.test.ts`, `dev-preview.test.ts`, `plugins/host-navigation.test.ts` et les tests layout si leurs actions changent. Conserver les ports et fakes existants ; ne pas étendre la suite JSDOM historique `host-navigation.test.tsx` pour les nouvelles règles.

**Interface du point d’entrée partagé :**

```ts
export type OpenWorkspaceBrowserInput = {
  workspaceKey: string;
  url?: string;
  browserId?: string;
  intent: "reveal" | "background";
  placement?: WorkspaceTabPlacement;
  insertionPosition?: WorkspaceTabInsertionPosition;
  parentTabId?: string;
  state?: JsonValue;
  replaceTabId?: string;
};
export type OpenWorkspaceBrowserResult =
  | { ok: true; tabId: string; browserId: string; created: boolean }
  | { ok: false; code: "workspace_unavailable" | "placement_unavailable" | "browser_unavailable" };
export function openWorkspaceBrowser(input: OpenWorkspaceBrowserInput): OpenWorkspaceBrowserResult;
```

`WorkspaceTabPlacement` est importé du layout store, `WorkspaceTabInsertionPosition` des actions layout et `JsonValue` du type protocole existant. `url` initialise une nouvelle page ; `browserId` désigne une page existante et ne déclenche pas de navigation, même si `url` est aussi fourni. Ne jamais réutiliser automatiquement une page parce que son URL correspond : deux onglets peuvent afficher la même URL.

`insertionPosition: { afterTabId }` possède l’ordre ; `parentTabId` possède la relation entre tabs et ne suffit pas à placer un onglet après sa source. `state` transporte le marqueur preview existant. `replaceTabId` est réservé à la création en mode `reveal` sur un lanceur `new_tab` du workspace ; valider cette cible avant de créer le record, puis utiliser `replaceTabTarget`. Les autres combinaisons de remplacement retournent `placement_unavailable`.

- [ ] Écrire un test rouge de création agent en arrière-plan dans `automation/handler.test.ts` : identité et sélection du panneau conversation inchangées, panneau navigateur masqué, onglet retourné utilisable par `snapshot`.
- [ ] Implémenter `openWorkspaceBrowser` : retrouver le couple host/workspace dans les descripteurs de `useSessionStore` en comparant leurs clés recomposées par `buildWorkspaceTabPersistenceKey` à `workspaceKey`, puis réutiliser `resolveWorkspaceMapKeyByIdentity`. Ne pas découper arbitrairement une clé opaque sur `:`. Un layout absent ne signifie pas un workspace absent ; tester une première ouverture dans un workspace connu mais jamais visité. Un ancien layout conservé ne prouve pas qu’un workspace existe ; tester un workspace supprimé. Initialiser ces descripteurs dans la fixture du handler et remettre à zéro les nouveaux maps de panneau/focus entre ses tests.
- [ ] Pour `browserId`, trouver d’abord le tab existant dans le workspace et vérifier son record ; révéler son emplacement actuel sans créer de panneau par défaut. Une destination `pane` explicitement demandée peut déplacer ce tab, `prefer` le laisse sur place. Un record seul ou un tab d’un autre workspace retourne `browser_unavailable` sans créer ni déplacer de page.
- [ ] Pour une nouvelle page, résoudre la destination avant de créer le `BrowserRecord`, puis appeler `openTab` avec l’intention reçue ou remplacer le lanceur validé. Vérifier les destinations explicites avant l’appel : les résolveurs layout actuels se rabattent sur un autre panneau si la cible manque. Ce point d’entrée retourne `placement_unavailable` au lieu d’utiliser ce fallback, sans changer les autres types de tabs.
- [ ] Ne pas révéler le panneau quand `intent === "background"` et préserver `focusedPaneId`, `focusedTabId` et `focusRestorationByWorkspace`. L’insertion dans une destination masquée fonctionne déjà dans `openTabInLayoutBackground` ; ne pas élargir les déplacements manuels, qui restent refusés. Adapter seulement les resets de présentation/focus qui violent ces tests.
- [ ] Si l’ouverture du tab échoue après création du record, supprimer uniquement ce record nouvellement créé. Ne jamais supprimer une page préexistante. Pour un échec de registration Electron, retourner l’erreur existante et nettoyer la création incomplète sans masquer la cause.
- [ ] Brancher les créations manuelles et URLs sur ce point d’entrée. Conserver le chemin explicite « remplacer le lanceur » et la destination du menu local : ces choix utilisateur ne doivent pas ouvrir ailleurs.
- [ ] Faire transmettre la requête `{ url, sourceBrowserId }` par `useDesktopBrowserNewTabRequests` jusqu’au callback d’ouverture. Résoudre le panneau depuis la cible source, puis fournir `placement: { mode: "pane", paneId }`, `insertionPosition: { afterTabId: sourceTabId }` et `parentTabId: sourceTabId`. Une source fermée entre l’événement et son traitement est ignorée sans création.
- [ ] Conserver les validations `http/https/about:blank` propres à l’événement Electron. Ne pas élargir le schéma public des outils agent ou celui des plugins.
- [ ] Brancher les previews en conservant `WorkspaceTab.state`, l’unicité par script, leur placement « à côté » explicite et leur proportion 25/75 initiale. `openTab` transmet aujourd’hui `state` uniquement pour `intent: "new"` : acheminer ce champ à la création en `reveal`/`background` et préserver celui d’un tab existant. Tester le marqueur après ouverture, reload et révélation d’une preview déplacée.
- [ ] Brancher les plugins par le port de navigation existant en conservant `navigateToWorkspace`, les URLs HTTP(S) et le host/workspace demandé. Sélectionner le tab via l’ouverture partagée, puis naviguer vers ce même workspace avec la cible explicite ; ne pas relancer une ouverture ambiante qui perdrait le placement. Tester deux hosts avec le même `workspaceId` et un workspace destination sans layout initial.
- [ ] Pour un placement impossible, afficher un `<Alert>` durable dans le contexte manuel avec possibilité de fermer un panneau et réessayer ; `Alert.alert()` ne produit pas de feedback sur React Native Web. Pour l’agent, mapper `workspace_unavailable` et `placement_unavailable` vers `browser_unsupported`, `browser_unavailable` vers `browser_tab_not_found`. Les erreurs bridge gardent `normalizeThrownBridgeError` et un timeout de registration garde `browser_timeout` ; aucun nouveau code RPC.
- [ ] Tester la même URL ouverte deux fois, la révélation d’un browser existant déplacé, un identifiant d’un autre workspace, l’échec de placement sans record orphelin et la conservation des métadonnées preview.

Exemple d’assertions à ajouter au test existant d’ouverture agent, avec les identifiants de sa fixture :

```ts
expect(after.layoutByWorkspace[workspaceKey].focusedPaneId).toBe(
  before.layoutByWorkspace[workspaceKey].focusedPaneId,
);
expect(after.layoutByWorkspace[workspaceKey].root).not.toEqual(
  before.layoutByWorkspace[workspaceKey].root,
);
expect(getBrowserRecord(createdBrowserId)?.url).toBe("http://localhost:3000");
expect(
  collectAllTabs(after.layoutByWorkspace[workspaceKey].root).filter(
    (tab) => tab.target.kind === "browser",
  ),
).toHaveLength(1);
```

- [ ] Exécuter séparément depuis `packages/app` : `npx vitest run src/desktop/browser/automation/handler.test.ts --bail=1`, `npx vitest run src/desktop/browser/new-tab-requests/index.test.ts --bail=1`, `npx vitest run src/workspace-tabs/dev-preview.test.ts --bail=1` et `npx vitest run src/plugins/host-navigation.test.ts --bail=1`, puis les tests layout s’ils ont changé et les contrôles communs. Résultat attendu : suites vertes, sans record orphelin, changement de focus ou déplacement implicite.

**Livrable :** tous les points d’entrée atteignent une page du bon workspace, avec la bonne intention de focus, sans changer les RPCs.

## Tâche 4 — Présenter les onglets comme un navigateur

**Fichiers :** modifier `workspace-desktop-tabs-row.tsx`, `workspace-tab-layout.ts`, `workspace-tab-layout.test.ts`, `split-container.tsx`, `desktop/browser/panel.tsx`, `desktop/browser/pane/index.electron.tsx` et les ressources i18n. Étendre le parcours Electron existant pour les interactions. `store/state.ts` n’a pas besoin d’une nouvelle permission URL : son normaliseur conserve déjà `about:blank` et le pane l’autorise explicitement. Ajouter les assertions nécessaires dans `store/state.test.ts` sans élargir les schémas publics.

**Interfaces :** ajouter `variant?: "workspace" | "browser"` aux props de la rangée existante, défaut `workspace`. En Electron, `SplitContainer` passe `browser` aux panneaux ordinaires composés uniquement de browsers, et au lanceur vide du panneau navigateur mémorisé. Les panneaux mixtes, Explorer, web et native gardent `workspace`. Réutiliser `onCreateNewTab`, `onNavigateTab`, `onCloseTab`, `onReorderTabs` et `onTogglePaneMaximized` ; aucun deuxième système de DnD.

La création manuelle passe `state: { browserAddressFocusPending: true }` à l’ouverture partagée. `BrowserPanel` lit ce marqueur dans le `PaneContext` existant et transmet `focusAddressOnOpen?: boolean` et `onAddressFocusHandled?: () => void` au pane. Celui-ci attend d’être présenté et interactif, donne le focus à l’adresse puis consomme le marqueur via `setCurrentTabState`, sans écraser les autres clés d’état. Aucun registre de focus par onglet ; les autres ouvertures ne posent pas ce marqueur.

- [ ] Tester d’abord les métriques : rangée de 360 px avec 10 onglets, retour en rangée large, titre très long et bouton de fermeture. Chaque onglet conserve favicon, zone de sélection et fermeture accessibles.
- [ ] Introduire des métriques navigateur initiales `minTabWidth: 120`, `maxTabWidth: 220` et un `variant?: "workspace" | "browser"` dans `WorkspaceTabLayoutInput`. Le défaut conserve le calcul actuel. Pour `browser`, borner `availableTabsWidth / tabCount` entre ces limites et donner cette largeur à tous les items, indépendamment de `tabLabelWidths`. Réutiliser le même résultat de layout et les limites de défilement ; les conversations conservent leurs métriques et largeurs naturelles.
- [ ] Utiliser une largeur égale par onglet dans la variante navigateur, bornée par ces métriques, afin qu’un changement de titre/favicon ne fasse pas bouger les autres onglets. Réserver les espaces de favicon et fermeture.
- [ ] Réutiliser `SortableInlineList`, les menus UI et les tooltips. Le `+` ouvre directement une page navigateur ; le menu de débordement liste les onglets du panneau, marque l’actif et permet de le sélectionner.
- [ ] Faire défiler la rangée uniquement si l’onglet sélectionné sort de la zone visible. Ne pas recentrer à chaque mise à jour de titre ou de chargement.
- [ ] Afficher la barre de navigation de la page active sous les tabs. Conserver les fonctions existantes de capture, annotation, viewport et outils dans leurs commandes existantes ou un menu secondaire ; ne pas retirer de fonctionnalité.
- [ ] Créer le nouvel onglet manuel avec `url: "about:blank"`, y compris depuis un lanceur explicite. Présenter un libellé traduit dans `panel.tsx` et une adresse vide dans le pane, sans écrire cette chaîne vide dans le record. Ne pas naviguer sur validation d’un champ vide. Donner le focus à l’adresse une seule fois lors de cette création manuelle active ; une révélation, un remontage ou une ouverture agent ne le reprend pas. Laisser intact le défaut agent `https://example.com` quand aucune URL n’est fournie.
- [ ] Ajouter le test d’acceptation Electron ci-dessous avec `page` et `originalDeck` du parcours existant ; utiliser les traductions anglaises fixées par sa fixture :

```js
const browserRow = originalDeck.getByRole("tablist", { name: "Browser tabs", exact: true });
await browserRow.getByRole("button", { name: "New browser tab", exact: true }).click();
const address = page.getByRole("textbox", { name: "Address", exact: true });
assert((await address.inputValue()) === "", "New tab must show an empty address");
assert(
  await address.evaluate((element) => document.activeElement === element),
  "New tab must focus the address before typing",
);
await address.fill(targetUrl);
await address.press("Enter");
assert(
  (await browserRow.getByRole("tab", { selected: true }).count()) === 1,
  "Browser row must have exactly one selected tab",
);
```

- [ ] Définir `tablist`, `tab`, sélection et navigation clavier cohérentes dans la variante navigateur : un seul tab dans l’ordre Tab, flèches gauche/droite et Home/End pour sélectionner, focus conservé sur la rangée. Ces touches restent locales à la rangée et ne s’appliquent pas à la page ou à l’adresse. Nommer la rangée « Browser tabs » dans la fixture anglaise ; chaque panneau possède son propre tab sélectionné, donc ne pas compter les tabs sélectionnés dans tout le workspace.
- [ ] Ajouter les clés dans toutes les langues existantes : « Onglets du navigateur », « Nouvel onglet navigateur », « Tous les onglets », « Masquer le navigateur », « Afficher le navigateur », « Réouvrir le dernier onglet fermé », « Adresse ». Réutiliser les clés existantes d’agrandissement/restauration lorsqu’elles conviennent.
- [ ] Exécuter séparément depuis `packages/app` : `npx vitest run src/screens/workspace/workspace-tab-layout.test.ts --bail=1`, `npx vitest run src/desktop/browser/store/state.test.ts --bail=1` et `npx vitest run src/i18n/resources.test.ts --bail=1`. Résultat attendu : suites vertes ; les titres/favicon n’influencent pas les largeurs navigateur et la variante workspace garde ses résultats. Exécuter ensuite le parcours Electron une fois la tâche 5 intégrée.

**Livrable :** rangée exploitable avec 1, 5 et 10 onglets, souris et clavier, sans modifier celle des conversations.

## Tâche 5 — Garantir continuité, masquage et vue agrandie

**Fichiers :** modifier `split-container.tsx`, `workspace-screen.tsx` et, uniquement si la mesure identifie un défaut, `desktop/browser/pane/index.electron.tsx` / `resident-webviews.ts`. Étendre `resident-webviews.browser.test.ts` et le parcours Electron.

**Interfaces :** `SplitContainer` possède actuellement l’état local `maximizedPane` ; `paneMaximized` est la prop de présentation de la rangée, pas une action du layout store. Garder cette propriété locale, `onTogglePaneMaximized`, le `hidden` du layout et `hideBrowserPane`. Ajouter le contrôle visible « Afficher/Masquer le navigateur » à l’en-tête workspace existant, seulement en Electron. Il révèle le panneau compatible mémorisé ou appelle `ensureBrowserPane(workspaceKey, { reveal: true })`, puis focalise ce panneau ; le masquage ne crée pas de panneau. Un panneau mixte reste régi par ses commandes génériques.

- [ ] Écrire un cas Electron qui masque/révèle puis agrandit/restaure le navigateur avec formulaire rempli, scroll et session locale. Comparer les mêmes propriétés que la tâche 1 après chaque transition.
- [ ] Brancher la maximisation existante. Ne pas déplacer les webviews dans une modale, ne pas reconstruire l’arbre de tabs et ne pas modifier les tailles persistées du split pour agrandir.
- [ ] Au masquage depuis une vue agrandie, invalider la maximisation dans son propriétaire. Dès le rendu, ne pas appliquer un `maximizedPaneId` dont le panneau est masqué ou supprimé ; nettoyer ensuite l’état local. Tester trois panneaux ordinaires dont le navigateur agrandi : l’effet actuel ne suffit pas lorsque deux autres panneaux restent visibles. Refuser le masquage du dernier panneau ordinaire, y compris avec Explorer ouvert.
- [ ] L’agrandissement volontaire focalise d’abord son panneau via `onFocusPane`. Dès le rendu, appliquer la maximisation seulement si ce panneau reste visible et focalisé ; nettoyer sinon l’état local. Ainsi, une révélation utilisateur dans un autre panneau le rend visible, même si le tab révélé était déjà sélectionné avant l’agrandissement. Une ouverture agent conserve le focus et donc la maximisation. Ne pas déplacer cet état de présentation dans le layout persisté.
- [ ] Stabiliser les callbacks et les clés qui portent le cycle de vie de la webview si le profiling montre un rattachement inutile. Garder une clé basée sur `browserId`, jamais sur l’URL, le titre ou l’index.
- [ ] Conserver le parking de production décrit dans `docs/browser-capture-harness.md`. Ne pas introduire `display:none`, `opacity:0`, reparentage à chaque sélection ou suppression générale du throttling.
- [ ] Tester les menus et annotations au-dessus de la page, les captures de pages masquées, le resize avec viewport fixe, puis une fenêtre minimisée et restaurée. Préserver l’isolation des touches entre page et composer.

```js
assert(restored.webContentsId === original.webContentsId, "Presentation destroyed the browser");
assert(
  restored.splitSizes.join(",") === original.splitSizes.join(","),
  "Full view changed split sizes",
);
assert(restored.composerDraft === original.composerDraft, "Full view lost the chat draft");
```

- [ ] Adapter la phase `after` du parcours actuel : après `browser_new_tab`, révéler le panneau via « Show browser » avant le premier clic sur son tab ; une page agent masquée n’est pas cliquable. Conserver les assertions d’identité et cibler les panes/rows concernées plutôt que leur ancien nombre global. Exécuter le fichier browser Vitest via `npm run test:browser --workspace=@getpaseo/app -- src/desktop/browser/resident-webviews.browser.test.ts --bail=1` s’il a changé, puis le parcours Electron des tâches 1–5 en phase `after`. Résultat attendu : aucune perte de DOM, saisie, scroll, sélection ou proportions.
- [ ] Si les mécanismes de capture/parking sont modifiés, exécuter également `PASEO_CAPTURE_HARNESS_GROUP=automation npm run capture-harness --workspace=@getpaseo/desktop` ; sinon réutiliser leurs résultats antérieurs disponibles et ne pas revendiquer un nouveau contrôle.

**Livrable :** navigation, masquage et agrandissement conservent les pages et la conversation.

## Tâche 6 — Fermer proprement et réouvrir le dernier onglet

**Fichiers :** étendre `workspace-tabs/browser.ts`, `desktop/browser/store/index.ts`, `desktop/browser/resident-webviews.ts`, `workspace-layout-store.ts`, `workspace-layout-actions.ts`, `workspace-screen.tsx`, `workspace/use-workspace-archive.ts`, `desktop/browser/automation/handler.ts`, `keyboard/actions.ts`, `keyboard/keyboard-shortcuts.ts`, `hooks/use-keyboard-shortcuts.ts`. Étendre `desktop/browser/automation/handler.test.ts`, `desktop/browser/store/state.test.ts`, `stores/workspace-layout-store.test.ts`, `keyboard/keyboard-shortcuts.test.ts` et `desktop/browser/shortcuts.test.ts` selon les changements. Ne pas modifier les fermetures des agents/terminaux.

**Interfaces :** ajouter au store navigateur un champ mémoire `lastClosedByWorkspace` de type `Record<string, { url: string; viewport: BrowserViewport; paneId: string | null }>` et l’exclure du `partialize`. Ajouter les deux fonctions suivantes dans `workspace-tabs/browser.ts` :

```ts
export function closeWorkspaceBrowser(input: {
  workspaceKey: string;
  browserId: string;
  remember: boolean;
}): Promise<void>;
export function reopenLastWorkspaceBrowser(workspaceKey: string): OpenWorkspaceBrowserResult;
```

- [ ] Écrire un test rouge pour une fermeture manuelle puis réouverture : dernière URL et viewport restaurés, nouvel identifiant, aucune réutilisation d’une référence DOM de l’ancienne page.
- [ ] Remettre aussi `lastClosedByWorkspace` à zéro dans les fixtures qui réutilisent le singleton browser ; un reset de `browsersById` seul ne nettoie pas ce nouvel état mémoire. Vérifier sa non-persistance via l’adapter de stockage existant du handler, puis recharger un store sans descriptif fermé.
- [ ] Centraliser uniquement le nettoyage navigateur : trouver le tab dans le workspace, prendre son descriptif si `remember`, retirer tab et record, détruire la page résidente, désenregistrer le browser Electron. Pour l’URL, lire le `getURL()` du guest prêt via un getter `readResidentBrowserUrl(browserId: string): string | null` dans `resident-webviews.ts`, avec les gardes web existants ; sinon utiliser le record. Une page jamais présentée peut avoir navigué sans les listeners du pane. Tester une navigation en arrière-plan suivie d’une fermeture/réouverture sur cette dernière URL. Reprendre l’erreur de bridge dans les retours existants au lieu de l’ignorer.
- [ ] Une deuxième fermeture est idempotente, y compris pendant l’attente du désenregistrement : retirer les références locales avant cet `await` et appeler le bridge une seule fois. Le handler garde son erreur `browser_tab_not_found` pour une seconde commande agent. Tester aussi une fermeture pendant la registration d’un `new_tab` : interrompre l’attente si le tab/record a disparu, retourner `browser_tab_closed` et ne jamais recréer le guest pour terminer la commande initiale.
- [ ] Consommer le descriptif seulement si la réouverture réussit. S’il n’y a pas de descriptif, retourner `browser_unavailable` et désactiver le menu ; ne pas créer un onglet par défaut.
- [ ] Appliquer la sélection du voisin définie dans la conception aux pages navigateur seulement, y compris dans un panneau mixte. `getCloseSuccessorTabId` donne aujourd’hui priorité à `parentTabId` : garder cette règle pour les autres cibles et la contourner pour un browser. Tester un enfant browser dont le voisin droit n’est pas son parent et une fermeture dans un panneau non focalisé, sans voler le focus workspace. La fermeture dans un panneau masqué sélectionne son voisin sans le révéler ; ne pas appeler `focusTabInLayout` sur ce chemin. Fermer le panneau navigateur compatible devenu vide seulement si un autre panneau ordinaire visible reste ; sinon garder le lanceur existant.
- [ ] À la réouverture, réutiliser l’ancien panneau seulement s’il existe, est ordinaire et reste compatible navigateur. Sinon utiliser le panneau navigateur par défaut. Appliquer le viewport sauvegardé avant la première présentation du nouveau guest, puis consommer le descriptif au succès. Un échec conserve ce descriptif et ne laisse aucun nouveau record.
- [ ] Brancher `remember: true` pour fermeture utilisateur ; `false` pour outil agent, arrêt de preview, rollback et purge. Au chemin de purge de `workspace/use-workspace-archive.ts`, capturer les browserIds avant de supprimer le layout et les fermer par ce helper. Effacer `lastClosedByWorkspace[workspaceKey]` dans `purgeWorkspace` lui-même, même sans layout restant. Reporter une erreur de bridge sans retenir les références d’un workspace déjà archivé. Tester la purge d’un workspace masqué et l’isolation du second workspace.
- [ ] Ajouter l’action `workspace.browser.reopen-last-closed` au menu navigateur et au registre configurable, avec disponibilité Electron, scope `browser` et présence du descriptif. `Cmd+Shift+T` et `Ctrl+Shift+T` sont déjà affectés à `workspace.terminal.new` dans `keyboard/keyboard-shortcuts.ts`, sans exclusion du scope navigateur. Conserver ces bindings ; déclarer la nouvelle définition avec `combo: ""`, déjà supporté par `parseBindingChord`, pour la rendre assignable dans Settings. Ajouter son id d’aide à `SHORTCUT_HELP_ROW_ORDER` et sa clé à `SHORTCUT_HELP_LABEL_KEYS` et aux ressources i18n. Tester cette absence de collision et la transmission d’un binding utilisateur via la policy browser existante.
- [ ] Conserver les raccourcis existants de création/fermeture/navigation. Vérifier leur passage depuis un champ de page, un iframe et pendant une composition IME ; ne pas ajouter de listener DOM global.

```ts
const result = reopenLastWorkspaceBrowser(workspaceKey);
expect(result.ok).toBe(true);
if (!result.ok) throw new Error(result.code);
expect(result.browserId).not.toBe(closedBrowserId);
expect(getBrowserRecord(result.browserId)?.url).toBe(closedUrl);
expect(getBrowserRecord(closedBrowserId)).toBeNull();
```

- [ ] Exécuter séparément les fichiers Vitest modifiés cités ci-dessus depuis `packages/app`, chacun avec `npx vitest run` et `--bail=1`, puis les contrôles communs. Résultat attendu : fermeture idempotente, viewport restauré, aucun descriptif persisté, voisin correct, binding terminal inchangé. Si le getter résident modifie sa suite browser, reprendre la commande ciblée de la tâche 5. Le parcours Electron final couvre le clavier, la dernière URL du guest et le vrai nettoyage des pages.

**Livrable :** fermeture complète sans fuite de guest, avec réouverture limitée et explicite de la dernière URL.

## Tâche 7 — Vérifier la qualité et livrer les preuves

**Fichiers :** compléter `packages/desktop/e2e/browser-tabs.e2e.mjs`, `packages/app/src/desktop/browser/pane/index.electron.tsx` pour l’erreur de crash, les ressources i18n et les suites ciblées précédentes. Mettre à jour les sections propriétaires de `docs/explorer-sidebar.md` pour le panneau navigateur et de `docs/browser-capture-harness.md` seulement si les invariants de capture changent ; ne pas recopier ce plan dans la documentation produit.

- [ ] Exécuter les scénarios fonctionnels finaux dans un runtime Electron isolé : 1/5/10 onglets, deux workspaces, même URL en double, drag, overflow, fermeture/réouverture, ouverture agent pendant saisie, vue partagée/agrandie, masquage, reload application et ancien layout.
- [ ] Vérifier l’erreur visible et le retry sur échec de navigation. Le pane gère aujourd’hui `did-fail-load`, mais pas `render-process-gone` : ajouter dans `pane/index.electron.tsx` un état d’erreur traduit et une action Recharger pour ce second événement, puis le provoquer dans le runtime isolé. Ne pas transformer les abandons de navigation `ERR_ABORTED` en crash ni étendre les RPCs.
- [ ] Vérifier un panneau navigateur devenu mixte, un onglet déplacé manuellement et un workspace purgé ; ni fermeture d’un terminal ni archivage d’agent ne doivent découler d’un toggle navigateur.
- [ ] Rejouer le protocole de mesure de la tâche 1, sur la même machine et dans le même mode de build. Si Metro perturbe la mesure, comparer une baseline de production reconstruite depuis l’état source initial à une build de production après changement, toutes deux isolées. Un passage de production après seul ne permet pas de conclure à un gain face à une baseline de développement.

**Cibles de validation proposées, à mesurer et non acquises :**

| Mesure                                                            | Cible                                                                                                                |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Feedback de sélection d’un onglet déjà chargé                     | p95 inférieur ou égal à 50 ms si la présentation du chrome hôte est mesurable par trace                              |
| Première présentation de la page déjà chargée                     | p95 inférieur ou égal à 100 ms si mesurable par trace compositeur                                                    |
| Navigation involontaire / guest recréé lors de 30 bascules        | 0                                                                                                                    |
| Perte de saisie, scroll ou focus dans les scénarios déterministes | 0                                                                                                                    |
| Ouverture agent modifiant focus ou largeur visible                | 0                                                                                                                    |
| Guests après ouverture de 10 puis fermeture de 9 pages            | 1 guest de la cohorte restant ; aucun guest des 9 pages fermées                                                      |
| Mémoire                                                           | publier les valeurs brutes avant/après ; aucune croissance monotone inexpliquée après répétition fermeture/ouverture |

Les seuils de temps ne deviennent pas des assertions CI instables sur machines partagées. Les invariants de continuité et de nombre de guests, eux, sont testés automatiquement. Si la cible de latence échoue, profiler le passage concerné et corriger la cause mesurée ; ne pas masquer l’attente avec une animation.

- [ ] Enregistrer les captures dans `packages/desktop/capture-harness/out/browser-tabs-final/` : partagé, agrandi, rangée saturée/menu, panneau masqué, nouvel onglet, erreur de navigation. Ajouter une vidéo courte pour le changement d’onglet.

```bash
PASEO_DESKTOP_BROWSER_E2E_PHASE=after PASEO_DESKTOP_BROWSER_E2E_ARTIFACT_DIR="$PWD/packages/desktop/capture-harness/out/browser-tabs-final" npm run test:e2e:browser-tabs --workspace=@getpaseo/desktop
```

Résultat attendu : invariants fonctionnels verts, `browser-tabs-after.json`, traces, vidéo et captures dans ce dossier. Les latences non attribuables à une frame présentée sont signalées comme telles ; aucun résultat n’est déduit d’une capture statique.

- [ ] Pour chaque état vérifié visuellement, intégrer une capture représentative et une légende dans le rapport final. Ne pas présenter une capture comme preuve d’un délai de rendu.
- [ ] Couvrir macOS en local ; utiliser les jobs desktop existants pour Windows/Linux. Vérifier le web et les versions natives si les changements des composants partagés les affectent, et déclarer les plateformes non testées.
- [ ] Revoir les différences de daemon : les outils existants doivent fonctionner sans nouvelle capacité protocole. Aucune mise à jour du daemon ne doit être exigée pour le chrome du navigateur.
- [ ] Terminer par les commandes communes ci-dessous. Ne pas reconstruire ni remplacer l’application installée pour cette tâche sans demande de livraison.

## Commandes communes et discipline d’exécution

À chaque tranche de code terminée, exécuter les tests des fichiers touchés depuis leur workspace. Ne pas lancer `npm run test` sur le workspace entier. Une fois verts, ne pas les relancer sans nouveau changement ou doute précis.

```bash
npm run typecheck
npm run lint
```

Résultat attendu : les deux commandes terminent avec code 0. Une erreur venant d’une tâche voisine est rapportée avec son fichier ; elle n’autorise ni sa correction dans cette tâche ni une affirmation de typecheck vert.

Si des déclarations inter-workspaces sont périmées : `npm run build:client` ou `npm run build:server` suivant le package propriétaire, puis reprendre le typecheck. Ne pas contourner avec des types dupliqués.

Avant un commit de l’implémentation : exécuter `npm run format` selon la règle du dépôt, examiner les changements de formatage et ne sélectionner que les fichiers de cette tâche. Comme le checkout est partagé et déjà modifié, travailler dans un checkout isolé à l’exécution est préférable pour éviter de reformater les travaux voisins.

Chaque tâche correspond à une tranche relisible. Si l’utilisateur demande des commits, créer un commit par tranche verte avec staging explicite, jamais `git add .` sur ce checkout. Aucun commit ni lancement d’implémentation n’est nécessaire pour livrer ce plan.

## Ordre et points de décision

1. Baseline Electron.
2. Panneau navigateur et persistance.
3. Ouvertures et contrat agent.
4. Barre d’onglets.
5. Continuité et vues partagée/agrandie.
6. Fermeture, réouverture et raccourcis.
7. Vérification complète du périmètre et preuves.

Les étapes 2 à 6 partagent le layout et le cycle de vie des pages : exécution séquentielle recommandée, puis revue finale. La première démonstration utile intervient après la tâche 5 ; la livraison demandée n’est complète qu’après les tâches 6 et 7.

Le critère de succès est observable : passer entre dix pages déjà chargées, conserver une saisie et la conversation, agrandir/restaurer le navigateur et laisser l’agent ouvrir un onglet en arrière-plan sans interruption. Le plan n’impose pas une réécriture du moteur pour atteindre ce résultat.
