Pod::Spec.new do |s|
  s.name = 'PaseoBrowserTunnel'
  s.version = '0.1.0'
  s.summary = 'Loopback socket bridge for the Paseo browser'
  s.description = 'Loopback socket bridge for the Paseo browser'
  s.license = 'Apache-2.0'
  s.author = 'Paseo'
  s.homepage = 'https://paseo.sh'
  s.platforms = { :ios => '13.4' }
  s.swift_version = '5.4'
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Network'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule' }
  s.source_files = '**/*.{h,m,swift}'
end
