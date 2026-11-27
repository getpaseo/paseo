# frozen_string_literal: true

module IosReview
  PLATFORM_IOS = "IOS"

  # Valid App Store Connect API v1 filter[appVersionState] values (fastlane 2.241.1
  # Spaceship::ConnectAPI::AppStoreVersion::AppVersionState) that block a new
  # App Store review submission.
  BLOCKING_API_VERSION_STATES = %w[
    WAITING_FOR_REVIEW
    IN_REVIEW
    PENDING_DEVELOPER_RELEASE
    PENDING_APPLE_RELEASE
    PROCESSING_FOR_DISTRIBUTION
    WAITING_FOR_EXPORT_COMPLIANCE
    ACCEPTED
  ].freeze

  # In-memory check also recognizes the deprecated AppStoreState alias
  # PROCESSING_FOR_APP_STORE (never sent in filter[appVersionState]).
  BLOCKING_VERSION_STATES = (BLOCKING_API_VERSION_STATES + %w[
    PROCESSING_FOR_APP_STORE
  ]).freeze

  # Valid filter[appVersionState] values shown in review_status under active/pending versions.
  ACTIVE_API_VERSION_STATES = (BLOCKING_API_VERSION_STATES + %w[
    PREPARE_FOR_SUBMISSION
    READY_FOR_REVIEW
    DEVELOPER_REJECTED
    REJECTED
    METADATA_REJECTED
    INVALID_BINARY
  ]).freeze

  # ReviewSubmission states representing an active submission already in Apple's queue
  # (or mid-cancellation). UNRESOLVED_ISSUES is intentionally excluded here so a
  # rejected version's free slot is not treated as an in-flight review; stale
  # UNRESOLVED_ISSUES submissions are cleared separately right before deliver runs.
  IN_FLIGHT_SUBMISSION_STATES = %w[
    WAITING_FOR_REVIEW
    IN_REVIEW
    CANCELING
  ].freeze

  UNRESOLVED_SUBMISSION_STATES = %w[
    UNRESOLVED_ISSUES
  ].freeze

  # ReviewSubmission states that can be cancelled via ReviewSubmission#cancel_submission
  # (or waited on if already CANCELING).
  CANCELLABLE_SUBMISSION_STATES = %w[
    WAITING_FOR_REVIEW
    IN_REVIEW
    UNRESOLVED_ISSUES
    CANCELING
  ].freeze

  STATUS_SUBMISSION_STATES = %w[
    WAITING_FOR_REVIEW
    IN_REVIEW
    UNRESOLVED_ISSUES
    CANCELING
    READY_FOR_REVIEW
  ].freeze

  DEFAULT_BUILD_TIMEOUT_SECONDS = 30 * 60
  DEFAULT_BUILD_POLL_INTERVAL = 30
  DEFAULT_CANCEL_TIMEOUT_SECONDS = 5 * 60
  DEFAULT_CANCEL_POLL_INTERVAL = 15

  # Thin adapter around Spaceship::ConnectAPI (fastlane 2.241.1).
  # Injected into IosReview operations so all workflow logic is unit-testable
  # against in-memory fakes without requiring live ASC credentials.
  class SpaceshipClient
    def authenticate!(key_id:, issuer_id:, key_filepath:)
      require "spaceship"
      Spaceship::ConnectAPI.token = Spaceship::ConnectAPI::Token.create(
        key_id: key_id,
        issuer_id: issuer_id,
        filepath: key_filepath,
      )
    end

    def find_app(bundle_id)
      Spaceship::ConnectAPI::App.find(bundle_id)
    end

    def live_version(app)
      app.get_live_app_store_version(platform: PLATFORM_IOS, includes: "build")
    end

    def ios_versions(app, states:)
      app.get_app_store_versions(
        filter: {
          platform: PLATFORM_IOS,
          appVersionState: states.join(","),
        },
        includes: "build",
      )
    end

    def get_app_store_version(app_store_version_id)
      Spaceship::ConnectAPI::AppStoreVersion.get(
        app_store_version_id: app_store_version_id,
        includes: "build",
      )
    end

    def review_submissions(app, states:)
      app.get_review_submissions(
        filter: {
          platform: PLATFORM_IOS,
          state: states.join(","),
        },
        includes: "appStoreVersionForReview",
      )
    end

    def get_review_submission(review_submission_id)
      Spaceship::ConnectAPI::ReviewSubmission.get(
        review_submission_id: review_submission_id,
        includes: "appStoreVersionForReview",
      )
    end

    def cancel_review_submission(submission)
      submission.cancel_submission
    end

    def find_ios_builds(app, version: nil, build_number: nil)
      if version.nil? && build_number.nil?
        return recent_ios_builds(app, limit: 25)
      end

      Spaceship::ConnectAPI::Build.all(
        app_id: app.id,
        version: version,
        build_number: build_number,
        platform: PLATFORM_IOS,
        sort: "-uploadedDate",
        limit: 100,
      )
    end

    def recent_ios_builds(app, limit: 5)
      fetch_limit = [limit * 4, 25].max
      builds = Spaceship::ConnectAPI.get_builds(
        filter: { app: app.id },
        includes: "preReleaseVersion",
        sort: "-uploadedDate",
        limit: fetch_limit,
      ).to_models
      builds.select { |b| b.pre_release_version&.platform == PLATFORM_IOS }.first(limit)
    end
  end

  module_function

  def parse_bool(value)
    value.to_s.strip.casecmp("true").zero?
  end

  def normalize_optional_string(value)
    str = value.to_s.strip
    str.empty? ? nil : str
  end

  def version_state(version)
    return nil if version.nil?

    state = version.respond_to?(:app_version_state) ? version.app_version_state : nil
    state = nil if state.to_s.strip.empty?
    return state unless state.nil?

    fallback = version.respond_to?(:app_store_state) ? version.app_store_state : nil
    fallback.to_s.strip.empty? ? nil : fallback
  end

  def blocking_version_state?(state)
    BLOCKING_VERSION_STATES.include?(state.to_s)
  end

  def sort_versions_descending(versions)
    versions.sort_by do |version|
      begin
        Gem::Version.new(version.version_string.to_s)
      rescue ArgumentError
        Gem::Version.new("0")
      end
    end.reverse
  end

  def find_blocking_review(client:, app:)
    versions = client.ios_versions(app, states: BLOCKING_API_VERSION_STATES)
      .select { |v| blocking_version_state?(version_state(v)) }

    if !versions.empty?
      version = sort_versions_descending(versions).first
      return {
        source: :app_store_version,
        version: version.version_string,
        state: version_state(version),
        build: version.respond_to?(:build) ? version.build&.version : nil,
        version_record: version,
      }
    end

    submissions = client.review_submissions(app, states: IN_FLIGHT_SUBMISSION_STATES)
      .select { |s| IN_FLIGHT_SUBMISSION_STATES.include?(s.state.to_s) }

    if !submissions.empty?
      submission = submissions.first
      assoc_version = submission.respond_to?(:app_store_version_for_review) ? submission.app_store_version_for_review : nil
      return {
        source: :review_submission,
        version: assoc_version&.version_string || "unknown",
        state: submission.state,
        build: assoc_version&.respond_to?(:build) ? assoc_version.build&.version : nil,
        submission: submission,
        version_record: assoc_version,
      }
    end

    nil
  end

  def wait_for_valid_build(
    client:,
    app:,
    target_version:,
    target_build:,
    ui:,
    timeout_seconds: DEFAULT_BUILD_TIMEOUT_SECONDS,
    poll_interval: DEFAULT_BUILD_POLL_INTERVAL,
    sleep_fn: Kernel.method(:sleep),
    clock: Time.method(:now)
  )
    if target_version
      ui.message("Targeting App Store version #{target_version}#{target_build ? " build #{target_build}" : ""} from workflow input")
    else
      ui.message("No APP_VERSION provided; selecting the most recently uploaded iOS build")
    end

    deadline = clock.call + timeout_seconds
    loop do
      builds = client.find_ios_builds(app, version: target_version, build_number: target_build)
        .select { |b| b.pre_release_version&.platform == PLATFORM_IOS }
      builds = builds.select { |b| b.pre_release_version&.version == target_version } if target_version
      builds = builds.select { |b| b.version.to_s == target_build.to_s } if target_build

      build = builds.first
      if build.nil?
        if clock.call >= deadline
          ui.user_error!("Timed out waiting for build to appear on App Store Connect.")
        end
        ui.message("No matching iOS build visible on App Store Connect yet; waiting...")
        sleep_fn.call(poll_interval)
        next
      end

      state = build.processing_state
      ui.message("Build #{build.pre_release_version.version} (#{build.version}) processing state: #{state || 'unknown'}")
      return build if state == "VALID"

      if state == "INVALID" || state == "FAILED"
        ui.user_error!("Build #{build.version} failed App Store processing (state: #{state}).")
      end

      if clock.call >= deadline
        ui.user_error!("Timed out waiting for build #{build.version} to finish processing on App Store Connect.")
      end
      sleep_fn.call(poll_interval)
    end
  end

  def resolve_waiting_build_summary(client:, app:, target_version:, target_build:)
    return [target_version, target_build] if target_version && target_build

    builds = client.find_ios_builds(app, version: target_version, build_number: target_build)
      .select { |b| b.pre_release_version&.platform == PLATFORM_IOS }
    builds = builds.select { |b| b.pre_release_version&.version == target_version } if target_version
    builds = builds.select { |b| b.version.to_s == target_build.to_s } if target_build
    latest = builds.first

    [
      target_version || latest&.pre_release_version&.version || "unknown",
      target_build || latest&.version&.to_s || "unknown",
    ]
  end

  def submit_review(
    client:,
    app:,
    ui:,
    deliver_runner:,
    target_version: nil,
    target_build: nil,
    replace_in_review: false,
    build_timeout_seconds: DEFAULT_BUILD_TIMEOUT_SECONDS,
    build_poll_interval: DEFAULT_BUILD_POLL_INTERVAL,
    cancel_timeout_seconds: DEFAULT_CANCEL_TIMEOUT_SECONDS,
    cancel_poll_interval: DEFAULT_CANCEL_POLL_INTERVAL,
    sleep_fn: Kernel.method(:sleep),
    clock: Time.method(:now)
  )
    target_version = normalize_optional_string(target_version)
    target_build = normalize_optional_string(target_build)

    blocking = find_blocking_review(client: client, app: app)

    if blocking && !replace_in_review
      return emit_skipped_result(
        client: client,
        app: app,
        ui: ui,
        blocking: blocking,
        target_version: target_version,
        target_build: target_build,
      )
    end

    valid_build = wait_for_valid_build(
      client: client,
      app: app,
      target_version: target_version,
      target_build: target_build,
      ui: ui,
      timeout_seconds: build_timeout_seconds,
      poll_interval: build_poll_interval,
      sleep_fn: sleep_fn,
      clock: clock,
    )

    app_version = valid_build.pre_release_version.version
    build_number = valid_build.version.to_s

    if replace_in_review
      cancel_result = cancel_review(
        client: client,
        app: app,
        ui: ui,
        expected_version: nil,
        timeout_seconds: cancel_timeout_seconds,
        poll_interval: cancel_poll_interval,
        sleep_fn: sleep_fn,
        clock: clock,
      )
      if cancel_result[:status] == :canceled
        ui.message("Proceeding to submit replacement build #{build_number} as App Store version #{app_version}")
      end
    else
      # Re-check after waiting for TestFlight processing so a review submitted
      # in the meantime is never disturbed.
      post_wait_blocking = find_blocking_review(client: client, app: app)
      if post_wait_blocking
        return emit_skipped_result(
          client: client,
          app: app,
          ui: ui,
          blocking: post_wait_blocking,
          target_version: app_version,
          target_build: build_number,
        )
      end

      # Fastlane's Deliver::SubmitForReview#create_review_submission fails if a
      # prior rejected ReviewSubmission remains in UNRESOLVED_ISSUES. Clear only
      # UNRESOLVED_ISSUES submissions here while keeping reject_if_possible: false
      # so an in-flight WAITING_FOR_REVIEW or IN_REVIEW submission is never cancelled.
      clear_unresolved_issues_submissions(
        client: client,
        app: app,
        ui: ui,
        timeout_seconds: cancel_timeout_seconds,
        poll_interval: cancel_poll_interval,
        sleep_fn: sleep_fn,
        clock: clock,
      )
    end

    ui.message("Submitting build #{build_number} as App Store version #{app_version} for review (reject_if_possible=#{replace_in_review})")
    deliver_runner.call(
      app_version: app_version,
      build_number: build_number,
      reject_if_possible: replace_in_review,
    )

    {
      status: :submitted,
      app_version: app_version,
      build_number: build_number,
      reject_if_possible: replace_in_review,
    }
  end

  def emit_skipped_result(client:, app:, ui:, blocking:, target_version:, target_build:)
    waiting_version, waiting_build = resolve_waiting_build_summary(
      client: client,
      app: app,
      target_version: target_version,
      target_build: target_build,
    )
    summary = "IOS_REVIEW_SKIPPED in_review_version=#{blocking[:version]} in_review_state=#{blocking[:state]} waiting_version=#{waiting_version} waiting_build=#{waiting_build}"
    ui.important(summary)
    ui.message(
      "Leaving iOS App Store version #{blocking[:version]} (#{blocking[:state]}) untouched. " \
      "TestFlight build #{waiting_version} (#{waiting_build}) is ready to submit later via " \
      "resubmit-ios-review.yml (or with replace_in_review=true to replace the in-flight review).",
    )
    {
      status: :skipped,
      summary: summary,
      in_review_version: blocking[:version],
      in_review_state: blocking[:state],
      waiting_version: waiting_version,
      waiting_build: waiting_build,
    }
  end

  def clear_unresolved_issues_submissions(
    client:,
    app:,
    ui:,
    timeout_seconds: DEFAULT_CANCEL_TIMEOUT_SECONDS,
    poll_interval: DEFAULT_CANCEL_POLL_INTERVAL,
    sleep_fn: Kernel.method(:sleep),
    clock: Time.method(:now)
  )
    stale_submissions = client.review_submissions(app, states: UNRESOLVED_SUBMISSION_STATES)
      .select { |s| UNRESOLVED_SUBMISSION_STATES.include?(s.state.to_s) }

    stale_submissions.each do |submission|
      assoc_version = submission.respond_to?(:app_store_version_for_review) ? submission.app_store_version_for_review : nil
      ui.message(
        "Clearing stale rejected review submission #{submission.id} " \
        "(version #{assoc_version&.version_string || 'unknown'}, state: #{submission.state}) before submitting...",
      )
      client.cancel_review_submission(submission)
      wait_for_submission_cancellation(
        client: client,
        submission: submission,
        assoc_version: assoc_version,
        ui: ui,
        timeout_seconds: timeout_seconds,
        poll_interval: poll_interval,
        sleep_fn: sleep_fn,
        clock: clock,
      )
    end
  end

  def wait_for_submission_cancellation(
    client:,
    submission:,
    assoc_version:,
    ui:,
    timeout_seconds:,
    poll_interval:,
    sleep_fn:,
    clock:
  )
    deadline = clock.call + timeout_seconds
    final_submission_state = submission.state
    final_version_state = version_state(assoc_version)

    loop do
      refreshed = client.get_review_submission(submission.id)
      final_submission_state = refreshed ? refreshed.state : "COMPLETE"
      submission_done = refreshed.nil? || !CANCELLABLE_SUBMISSION_STATES.include?(refreshed.state.to_s)

      version_done = true
      if assoc_version&.id
        refreshed_version = client.get_app_store_version(assoc_version.id)
        final_version_state = version_state(refreshed_version) || final_version_state
        version_done = !%w[WAITING_FOR_REVIEW IN_REVIEW].include?(final_version_state.to_s)
      end

      return [final_submission_state, final_version_state] if submission_done && version_done

      if clock.call >= deadline
        ui.user_error!(
          "Timed out waiting for iOS review submission #{submission.id} cancellation to complete " \
          "(submission_state=#{final_submission_state}, version_state=#{final_version_state || 'unknown'}).",
        )
      end

      ui.message("Waiting for cancellation to take effect (submission=#{final_submission_state}, version=#{final_version_state || 'unknown'})...")
      sleep_fn.call(poll_interval)
    end
  end

  def cancel_review(
    client:,
    app:,
    ui:,
    expected_version: nil,
    timeout_seconds: DEFAULT_CANCEL_TIMEOUT_SECONDS,
    poll_interval: DEFAULT_CANCEL_POLL_INTERVAL,
    sleep_fn: Kernel.method(:sleep),
    clock: Time.method(:now)
  )
    expected_version = normalize_optional_string(expected_version)

    submissions = client.review_submissions(app, states: CANCELLABLE_SUBMISSION_STATES)
      .select { |s| CANCELLABLE_SUBMISSION_STATES.include?(s.state.to_s) }
    blocking_versions = client.ios_versions(app, states: BLOCKING_API_VERSION_STATES)
      .select { |v| blocking_version_state?(version_state(v)) }

    if submissions.empty?
      non_cancellable = sort_versions_descending(blocking_versions).first
      if non_cancellable
        state = version_state(non_cancellable)
        ui.user_error!(
          "Cannot cancel iOS App Store version #{non_cancellable.version_string} (state: #{state}): " \
          "no cancellable review submission is in progress on App Store Connect.",
        )
      end

      suffix = expected_version ? " expected_version=#{expected_version}" : ""
      summary = "IOS_REVIEW_CANCEL_NOOP reason=no_active_review#{suffix}"
      ui.message(summary)
      ui.message("No iOS App Store review submission is currently in flight.")
      return { status: :noop, summary: summary }
    end

    submission = submissions.first
    assoc_version = submission.respond_to?(:app_store_version_for_review) ? submission.app_store_version_for_review : nil
    if assoc_version.nil?
      assoc_version = sort_versions_descending(blocking_versions).find do |v|
        %w[WAITING_FOR_REVIEW IN_REVIEW].include?(version_state(v))
      end
    end

    active_version = assoc_version&.version_string
    if expected_version && active_version != expected_version
      ui.user_error!(
        "Refusing to cancel iOS review: expected version #{expected_version}, " \
        "but active review submission #{submission.id} is for version #{active_version || 'unknown'} (state: #{submission.state}).",
      )
    end

    if submission.state == "CANCELING"
      ui.message("Review submission #{submission.id} (version #{active_version || 'unknown'}) is already CANCELING; waiting for completion...")
    else
      ui.message("Cancelling iOS review submission #{submission.id} for version #{active_version || 'unknown'} (state: #{submission.state})...")
      client.cancel_review_submission(submission)
    end

    final_submission_state, final_version_state = wait_for_submission_cancellation(
      client: client,
      submission: submission,
      assoc_version: assoc_version,
      ui: ui,
      timeout_seconds: timeout_seconds,
      poll_interval: poll_interval,
      sleep_fn: sleep_fn,
      clock: clock,
    )

    summary = "IOS_REVIEW_CANCELED version=#{active_version || 'unknown'} submission_id=#{submission.id} submission_state=#{final_submission_state} version_state=#{final_version_state || 'unknown'}"
    ui.success(summary)

    {
      status: :canceled,
      summary: summary,
      version: active_version,
      submission_id: submission.id,
      submission_state: final_submission_state,
      version_state: final_version_state,
    }
  end

  def review_status(client:, app:, ui:, app_identifier: "sh.paseo", recent_build_limit: 5)
    live = client.live_version(app)
    active_versions = sort_versions_descending(
      client.ios_versions(app, states: ACTIVE_API_VERSION_STATES),
    )
    active_submissions = client.review_submissions(app, states: STATUS_SUBMISSION_STATES)
    recent_builds = client.recent_ios_builds(app, limit: recent_build_limit)

    lines = ["=== iOS App Store Review Status (#{app_identifier}) ==="]

    lines << "Live App Store version:"
    if live
      lines << format_version_line(live)
    else
      lines << "  (none)"
    end

    lines << "Active / pending App Store versions:"
    if active_versions.empty?
      lines << "  (none)"
    else
      active_versions.each { |v| lines << format_version_line(v) }
    end

    lines << "Active review submissions:"
    if active_submissions.empty?
      lines << "  (none)"
    else
      active_submissions.each do |s|
        assoc = s.respond_to?(:app_store_version_for_review) ? s.app_store_version_for_review : nil
        submitted = s.respond_to?(:submitted_date) && s.submitted_date ? s.submitted_date : "none"
        lines << "  id=#{s.id} | version=#{assoc&.version_string || 'unknown'} | state=#{s.state} | submitted_date=#{submitted}"
      end
    end

    lines << "Recent iOS TestFlight builds (top #{recent_build_limit}):"
    if recent_builds.empty?
      lines << "  (none)"
    else
      recent_builds.each_with_index do |b, idx|
        ver = b.pre_release_version&.version || "unknown"
        lines << "  #{idx + 1}. version=#{ver} | build=#{b.version} | processing_state=#{b.processing_state || 'unknown'} | uploaded_date=#{b.uploaded_date || 'unknown'}"
      end
    end

    report = lines.join("\n")
    ui.message(report)

    {
      live_version: live,
      active_versions: active_versions,
      active_submissions: active_submissions,
      recent_builds: recent_builds,
      report: report,
    }
  end

  def format_version_line(version)
    state = version_state(version) || "unknown"
    build_number = version.respond_to?(:build) ? version.build&.version : nil
    "  version=#{version.version_string} | state=#{state} | build=#{build_number || 'none'}"
  end
end
