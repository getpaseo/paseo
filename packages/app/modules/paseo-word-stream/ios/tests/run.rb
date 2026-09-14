# Run on macOS: ruby run.rb <output-directory> <simulator-UDID>
require 'xcodeproj'
require 'fileutils'

output, device = ARGV
abort 'Usage: ruby run.rb <output-directory> <simulator-UDID>' unless output && device
output = File.expand_path(output)
FileUtils.mkdir_p(output)
project = Xcodeproj::Project.new(File.join(output, 'WordFadeNative.xcodeproj'))
app = project.new_target(:application, 'WordFadeHost', :ios, '15.1')
tests = project.new_target(:unit_test_bundle, 'WordFadeTests', :ios, '15.1')
host_source = File.join(output, 'Host.swift')
File.write(host_source, "import UIKit\n@main final class Host: UIResponder, UIApplicationDelegate {}\n")
app.add_file_references([project.main_group.new_file(host_source)])
tests.add_file_references([
  project.main_group.new_file(File.expand_path('../internal/TailFadeInAnimator.swift', __dir__)),
  project.main_group.new_file(File.join(__dir__, 'WordFadeTests.swift'))
])
tests.add_dependency(app)
[app, tests].each do |target|
  target.build_configurations.each do |config|
    config.build_settings.merge!({
      'SWIFT_VERSION' => '5.9', 'GENERATE_INFOPLIST_FILE' => 'YES',
      'PRODUCT_BUNDLE_IDENTIFIER' => "sh.paseo.wordstream.#{target.name}",
      'CODE_SIGNING_ALLOWED' => 'NO', 'TARGETED_DEVICE_FAMILY' => '1,2'
    })
  end
end
tests.build_configurations.each do |config|
  config.build_settings['TEST_HOST'] = '$(BUILT_PRODUCTS_DIR)/WordFadeHost.app/WordFadeHost'
  config.build_settings['BUNDLE_LOADER'] = '$(TEST_HOST)'
end
project.save
scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(app)
scheme.add_test_target(tests)
scheme.set_launch_target(app)
scheme.test_action.build_configuration = 'Release'
scheme.save_as(project.path, 'WordFadeNative')
exec 'xcodebuild', '-project', project.path.to_s, '-scheme', 'WordFadeNative', '-destination', "platform=iOS Simulator,id=#{device}", '-derivedDataPath', File.join(output, 'derived'), '-resultBundlePath', File.join(output, 'results.xcresult'), 'test'
