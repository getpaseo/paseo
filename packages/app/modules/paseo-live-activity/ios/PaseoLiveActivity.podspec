require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'PaseoLiveActivity'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = 'Paseo'
  s.homepage       = 'https://paseo.sh'
  s.platforms      = {
    :ios => '15.1'
  }
  s.swift_version  = '5.9'
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # The app target remains 15.1; weak-link ActivityKit because call sites use
  # iOS 16.2 APIs and are fenced with @available(iOS 16.2, *).
  s.weak_frameworks = 'ActivityKit'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  # PaseoFleetAttributes.swift is a symlink into ../../../targets/paseo-live-activity
  # so the ActivityKit contract has one definition shared with the widget
  # extension. CocoaPods globs symlinked files, Xcode compiles through them; a
  # `../` source_files pattern would silently match nothing because CocoaPods
  # matches patterns against a cached listing of the pod root.
  s.source_files = '**/*.{h,m,mm,swift}'
end
