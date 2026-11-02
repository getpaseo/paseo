/**
 * Project suggestions: folders the user already ran agents in, offered as projects to add.
 * Requires the host's `projectSuggestions` feature; on older hosts the list renders nothing.
 */
export { FolderProjectIcon } from "./internal/folder-project-icon";
export { ProjectSuggestionList } from "./internal/project-suggestions";
export {
  useProjectSuggestions,
  type ProjectSuggestionsController,
} from "./internal/use-project-suggestions";
