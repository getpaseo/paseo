import Foundation

// Only explicit local file URLs or absolute paths can identify a filesystem location.
func captureLocalPath(_ value: String) -> String? {
  if value.hasPrefix("/") { return value }
  guard let url = URL(string: value), url.isFileURL,
    url.host == nil || url.host == "" || url.host == "localhost"
  else { return nil }
  return url.path
}
