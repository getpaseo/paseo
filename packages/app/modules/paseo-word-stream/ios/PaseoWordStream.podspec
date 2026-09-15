Pod::Spec.new do |s|
  s.name = 'PaseoWordStream'
  s.version = '0.1.0'
  s.summary = 'Native word streaming for Paseo'
  s.description = 'Native word streaming for Paseo'
  s.license = { :type => 'MIT', :file => '../LICENSE' }
  s.author = 'Paseo'
  s.homepage = 'https://paseo.sh'
  s.platforms = { :ios => '15.1' }
  s.swift_version = '5.9'
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = ['*.swift', 'internal/*.swift']
end
