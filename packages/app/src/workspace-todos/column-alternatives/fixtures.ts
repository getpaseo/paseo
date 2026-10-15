export interface Task {
  id: string;
  title: string;
  notes: string;
  status: "todo" | "in_progress" | "done";
}
// Snapshot of the user's nine tasks. All prototype edits stay in React state.
export const INITIAL_TASKS: Task[] = [
  {
    id: "42fca214-2e69-4420-bd9e-90ee2c4f2183",
    title: "Ajouter l’ouverture et la sélection par clic maintenu à tous les dropdowns",
    notes:
      "Contrôleur web partagé, menus, sélecteurs et variantes personnalisées ; tactile et clavier préservés.",
    status: "done",
  },
  {
    id: "a91b315a-10df-4e8c-ba73-6813e3d89eeb",
    title: "Vérifier les interactions et documenter le comportement",
    notes: "Tests ciblés réels, typecheck, lint et captures navigateur/Electron.",
    status: "done",
  },
  {
    id: "969111b1-9e9b-4353-bb39-044faad8cb57",
    title: "Corriger les couleurs de la popup externe de validation et modification des plans",
    notes:
      "Palette beige #f9f7f4 / en-tête #383534 et comportements récents conservés dans 20863c767, publié et installé. Contrôle et capture de la véritable fenêtre Electron du paquet signé réussis. Première relance de l’ancienne interface encore nécessaire.",
    status: "done",
  },
  {
    id: "adb5933b-0247-4217-b109-c7e90ec34fc0",
    title: "Rétablir le RPC de handoff par profil dans les sources et le plugin",
    notes:
      "Suivre les sources versionnées du Paseo Local Builder, corriger le contrat et les références, produire et recharger uniquement paseo-workflow.",
    status: "done",
  },
  {
    id: "92176d6c-b70c-44e9-b719-656a3d22d5f6",
    title: "Activer les profils de handoff dans la popup installée",
    notes:
      "Relancer uniquement Paseo Local ; conserver le PID 6767, rouvrir le plan en attente et vérifier le scénario Electron isolé sans exécution réelle.",
    status: "in_progress",
  },
  {
    id: "399c7281-1c13-4913-b30e-1a0c28a2f643",
    title: "Fiabiliser la publication et l’activation des versions locales",
    notes:
      "20863c767 publiée/installée et vérifiée (signature, bundle, popup, masquage/restauration, tests). Sylvain autorise explicitement le redémarrage après fin des agents. Contrôleur indépendant préparé : fermeture ancienne GUI, arrêt ancien superviseur, ouverture app installée, vérification nouveaux PID/même serveur/build actif. Résultat à lire dans reliable-local-release/.artifacts/version-audit/restart-result.json ; ne marquer terminé qu’après phase=verified.",
    status: "in_progress",
  },
  {
    id: "cdc820ae-82bf-45f8-a077-b3ab96d1a6ec",
    title: "Auditer les travaux récents et leur présence dans la version installée",
    notes:
      "Audit terminé : dernière publication installée 716ca103d, interface encore ancienne. 12 commits navigateur + 2 commits locaux partiellement repris + dropdowns non commités retrouvés. Miroir iCloud externe en échec. Rapport dans reliable-local-release/.artifacts/version-audit/audit.md. L’utilisateur autorise leur consolidation, navigateur compris.",
    status: "done",
  },
  {
    id: "d06cb736-f537-489d-910a-9c4f30a336a2",
    title: "Consolider tous les travaux et bloquer les publications incomplètes",
    notes:
      "20863c767 publiée/installée, signature et identités vérifiées. Navigateur, corrections locales et dropdowns intégrés ; tests ciblés, typecheck/lint, revue et Electron réels verts. 41 refs incluses, checkouts synchronisés, plugin workflow activé. Attente : première relance GUI + confirmation active ; accord demandé pour daemon (24814 inchangé). Archive iCloud 20863 publiée au premier plan, checksum vérifié ; LaunchAgent encore refusé par macOS au remplacement de latest.sha256. MacBook non vérifié. Rapport : reliable-local-release/.artifacts/version-audit/delivery.md.",
    status: "in_progress",
  },
  {
    id: "a76ae643-e9c7-44c1-89aa-215671c18b52",
    title:
      "Intégrer les réponses interactives OpenUI et l’approfondissement dans les conversations",
    notes:
      "Plan approuvé 01a13aed : contrats, stockage, outils, rendu multiplateforme isolé, interactions persistantes, tests ciblés et livraison Paseo Local.",
    status: "in_progress",
  },
];
