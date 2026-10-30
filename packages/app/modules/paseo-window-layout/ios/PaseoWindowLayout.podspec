Pod::Spec.new do |s|
  s.name           = 'PaseoWindowLayout'
  s.version        = '0.1.0'
  s.summary        = 'Window-local system bar geometry for Paseo'
  s.description    = 'Window-local system bar geometry for Paseo'
  s.license        = 'Apache-2.0'
  s.author         = 'Paseo'
  s.homepage       = 'https://paseo.sh'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.4'
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.{h,m,swift}'
end
