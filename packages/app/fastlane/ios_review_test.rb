# frozen_string_literal: true

require "minitest/autorun"
require_relative "ios_review"

class IosReviewTest < Minitest::Test
  FakeApp = Struct.new(:id, :bundle_id, keyword_init: true)
  FakePreReleaseVersion = Struct.new(:version, :platform, keyword_init: true)
  FakeBuild = Struct.new(:version, :processing_state, :uploaded_date, :pre_release_version, keyword_init: true)
  FakeAppStoreVersion = Struct.new(:id, :version_string, :app_version_state, :app_store_state, :build, keyword_init: true)
  FakeReviewSubmission = Struct.new(:id, :state, :submitted_date, :app_store_version_for_review, keyword_init: true)

  class FakeUserError < StandardError; end

  class FakeUI
    attr_reader :messages, :importants, :successes

    def initialize
      @messages = []
      @importants = []
      @successes = []
    end

    def message(text)
      @messages << text
    end

    def important(text)
      @importants << text
    end

    def success(text)
      @successes << text
    end

    def user_error!(text)
      raise FakeUserError, text
    end
  end

  class FakeClock
    attr_reader :now

    def initialize(start = 1_000)
      @now = start
    end

    def call
      @now
    end

    def advance(seconds)
      @now += seconds
    end
  end

  # In-memory fake matching the SpaceshipClient surface.
  class FakeClient
    attr_accessor :live_version_record, :versions, :submissions, :builds
    attr_reader :canceled_submission_ids, :queried_version_state_filters, :queried_submission_state_filters

    def initialize(
      live_version_record: nil,
      versions: [],
      submissions: [],
      builds: [],
      submission_poll_states: nil,
      version_poll_states: nil
    )
      @live_version_record = live_version_record
      @versions = versions
      @submissions = submissions
      @builds = builds
      @submission_poll_states = submission_poll_states || {}
      @version_poll_states = version_poll_states || {}
      @canceled_submission_ids = []
      @queried_version_state_filters = []
      @queried_submission_state_filters = []
    end

    def live_version(_app)
      @live_version_record
    end

    def ios_versions(_app, states:)
      @queried_version_state_filters << states
      @versions.select do |v|
        state = IosReview.version_state(v)
        states.include?(state) || (state == "PROCESSING_FOR_APP_STORE" && states.include?("PROCESSING_FOR_DISTRIBUTION"))
      end
    end

    def get_app_store_version(app_store_version_id)
      version = @versions.find { |v| v.id == app_store_version_id }
      return nil if version.nil?

      queue = @version_poll_states[app_store_version_id]
      if queue && !queue.empty?
        next_state = queue.shift
        version.app_version_state = next_state
      end
      version
    end

    def review_submissions(_app, states:)
      @queried_submission_state_filters << states
      @submissions.select { |s| states.include?(s.state) }
    end

    def get_review_submission(review_submission_id)
      submission = @submissions.find { |s| s.id == review_submission_id }
      return nil if submission.nil?

      queue = @submission_poll_states[review_submission_id]
      if queue && !queue.empty?
        submission.state = queue.shift
      end
      submission
    end

    def cancel_review_submission(submission)
      @canceled_submission_ids << submission.id
      submission.state = "CANCELING"
      submission
    end

    def find_ios_builds(_app, version: nil, build_number: nil)
      result = @builds.select { |b| b.pre_release_version&.platform == "IOS" }
      result = result.select { |b| b.pre_release_version&.version == version } if version
      result = result.select { |b| b.version.to_s == build_number.to_s } if build_number
      result
    end

    def recent_ios_builds(_app, limit: 5)
      @builds.select { |b| b.pre_release_version&.platform == "IOS" }.first(limit)
    end
  end

  def setup
    @app = FakeApp.new(id: "app-1", bundle_id: "sh.paseo")
    @ui = FakeUI.new
    @clock = FakeClock.new
    @sleep_fn = lambda { |seconds| @clock.advance(seconds) }
  end

  def make_build(version, build_number, processing_state: "VALID", uploaded_date: "2026-11-27T10:00:00Z", platform: "IOS")
    FakeBuild.new(
      version: build_number,
      processing_state: processing_state,
      uploaded_date: uploaded_date,
      pre_release_version: FakePreReleaseVersion.new(version: version, platform: platform),
    )
  end

  def test_submit_review_skips_when_blocking_version_is_in_flight_by_default
    blocking_states = %w[
      WAITING_FOR_REVIEW
      IN_REVIEW
      PENDING_DEVELOPER_RELEASE
      PENDING_APPLE_RELEASE
      PROCESSING_FOR_DISTRIBUTION
      PROCESSING_FOR_APP_STORE
      WAITING_FOR_EXPORT_COMPLIANCE
      ACCEPTED
    ]

    blocking_states.each do |state|
      ui = FakeUI.new
      in_flight = if state == "PROCESSING_FOR_APP_STORE"
        FakeAppStoreVersion.new(id: "v-1", version_string: "0.18.0", app_version_state: nil, app_store_state: state)
      else
        FakeAppStoreVersion.new(id: "v-1", version_string: "0.18.0", app_version_state: state)
      end

      client = FakeClient.new(
        versions: [in_flight],
        builds: [make_build("0.18.1", "18001999")],
      )
      deliver_calls = []

      result = IosReview.submit_review(
        client: client,
        app: @app,
        ui: ui,
        target_version: "0.18.1",
        target_build: "18001999",
        replace_in_review: false,
        deliver_runner: ->(args) { deliver_calls << args },
        sleep_fn: @sleep_fn,
        clock: @clock,
      )

      assert_equal :skipped, result[:status], "Expected skip for blocking state #{state}"
      assert_equal "0.18.0", result[:in_review_version]
      assert_equal state, result[:in_review_state]
      assert_equal "0.18.1", result[:waiting_version]
      assert_equal "18001999", result[:waiting_build]
      assert_empty client.canceled_submission_ids, "Must never cancel when replace_in_review is false (#{state})"
      assert_empty deliver_calls, "Must not invoke deliver when skipping (#{state})"
      assert_includes ui.importants.first, "IOS_REVIEW_SKIPPED in_review_version=0.18.0 in_review_state=#{state} waiting_version=0.18.1 waiting_build=18001999"
    end
  end

  def test_submit_review_never_sends_deprecated_app_store_state_in_api_filter
    client = FakeClient.new(
      versions: [FakeAppStoreVersion.new(id: "v-1", version_string: "0.18.0", app_version_state: "READY_FOR_DISTRIBUTION")],
      builds: [make_build("0.18.1", "18001999")],
    )

    IosReview.submit_review(
      client: client,
      app: @app,
      ui: @ui,
      target_version: "0.18.1",
      target_build: "18001999",
      replace_in_review: false,
      deliver_runner: ->(_args) {},
      sleep_fn: @sleep_fn,
      clock: @clock,
    )

    client.queried_version_state_filters.each do |states|
      refute_includes states, "PROCESSING_FOR_APP_STORE"
      refute_includes states, "READY_FOR_SALE"
    end
  end

  def test_submit_review_skips_and_resolves_latest_testflight_build_when_inputs_unset
    in_flight = FakeAppStoreVersion.new(id: "v-1", version_string: "0.18.0", app_version_state: "IN_REVIEW")
    client = FakeClient.new(
      versions: [in_flight],
      builds: [make_build("0.18.2", "18002999")],
    )
    deliver_calls = []

    result = IosReview.submit_review(
      client: client,
      app: @app,
      ui: @ui,
      target_version: "",
      target_build: "",
      replace_in_review: false,
      deliver_runner: ->(args) { deliver_calls << args },
      sleep_fn: @sleep_fn,
      clock: @clock,
    )

    assert_equal :skipped, result[:status]
    assert_equal "0.18.2", result[:waiting_version]
    assert_equal "18002999", result[:waiting_build]
    assert_empty client.canceled_submission_ids
    assert_empty deliver_calls
    assert_includes @ui.importants.first, "IOS_REVIEW_SKIPPED in_review_version=0.18.0 in_review_state=IN_REVIEW waiting_version=0.18.2 waiting_build=18002999"
  end

  def test_submit_review_auto_submits_when_slot_is_free
    free_states = %w[
      READY_FOR_DISTRIBUTION
      READY_FOR_SALE
      PREPARE_FOR_SUBMISSION
      DEVELOPER_REJECTED
      REJECTED
      METADATA_REJECTED
    ]

    free_states.each do |state|
      ui = FakeUI.new
      existing = FakeAppStoreVersion.new(
        id: "v-1",
        version_string: "0.18.0",
        app_version_state: state == "READY_FOR_SALE" ? nil : state,
        app_store_state: state == "READY_FOR_SALE" ? state : nil,
      )
      client = FakeClient.new(
        versions: [existing],
        builds: [make_build("0.18.1", "18001999")],
      )
      deliver_calls = []

      result = IosReview.submit_review(
        client: client,
        app: @app,
        ui: ui,
        target_version: "0.18.1",
        target_build: "18001999",
        replace_in_review: false,
        deliver_runner: ->(args) { deliver_calls << args },
        sleep_fn: @sleep_fn,
        clock: @clock,
      )

      assert_equal :submitted, result[:status], "Expected auto-submit when state is #{state}"
      assert_equal false, result[:reject_if_possible]
      assert_empty client.canceled_submission_ids
      assert_equal [{ app_version: "0.18.1", build_number: "18001999", reject_if_possible: false }], deliver_calls
    end
  end

  def test_submit_review_clears_stale_unresolved_issues_submission_on_rejected_version_by_default
    rejected = FakeAppStoreVersion.new(id: "v-1", version_string: "0.18.0", app_version_state: "REJECTED")
    stale_submission = FakeReviewSubmission.new(
      id: "sub-rejected",
      state: "UNRESOLVED_ISSUES",
      app_store_version_for_review: rejected,
    )
    client = FakeClient.new(
      versions: [rejected],
      submissions: [stale_submission],
      builds: [make_build("0.18.1", "18001999")],
      submission_poll_states: { "sub-rejected" => %w[CANCELING COMPLETE] },
      version_poll_states: { "v-1" => %w[REJECTED DEVELOPER_REJECTED] },
    )
    deliver_calls = []

    result = IosReview.submit_review(
      client: client,
      app: @app,
      ui: @ui,
      target_version: "0.18.1",
      target_build: "18001999",
      replace_in_review: false,
      deliver_runner: ->(args) { deliver_calls << args },
      sleep_fn: @sleep_fn,
      clock: @clock,
    )

    assert_equal :submitted, result[:status]
    assert_equal false, result[:reject_if_possible]
    assert_equal ["sub-rejected"], client.canceled_submission_ids
    assert_equal "COMPLETE", stale_submission.state
    assert_equal [{ app_version: "0.18.1", build_number: "18001999", reject_if_possible: false }], deliver_calls
  end

  def test_submit_review_skips_if_review_starts_while_waiting_for_build_processing
    processing_build = make_build("0.18.1", "18001999", processing_state: "PROCESSING")
    client = FakeClient.new(versions: [], submissions: [], builds: [processing_build])
    deliver_calls = []

    sleep_and_start_review = lambda do |seconds|
      @clock.advance(seconds)
      processing_build.processing_state = "VALID"
      client.versions << FakeAppStoreVersion.new(id: "v-race", version_string: "0.18.0", app_version_state: "WAITING_FOR_REVIEW")
    end

    result = IosReview.submit_review(
      client: client,
      app: @app,
      ui: @ui,
      target_version: "0.18.1",
      target_build: "18001999",
      replace_in_review: false,
      deliver_runner: ->(args) { deliver_calls << args },
      sleep_fn: sleep_and_start_review,
      clock: @clock,
    )

    assert_equal :skipped, result[:status]
    assert_equal "0.18.0", result[:in_review_version]
    assert_equal "WAITING_FOR_REVIEW", result[:in_review_state]
    assert_empty client.canceled_submission_ids
    assert_empty deliver_calls
    assert_includes @ui.importants.first, "IOS_REVIEW_SKIPPED in_review_version=0.18.0 in_review_state=WAITING_FOR_REVIEW waiting_version=0.18.1 waiting_build=18001999"
  end

  def test_submit_review_with_replace_in_review_cancels_after_validating_build_and_passes_reject_if_possible
    in_flight_version = FakeAppStoreVersion.new(id: "v-1", version_string: "0.18.0", app_version_state: "IN_REVIEW")
    submission = FakeReviewSubmission.new(id: "sub-1", state: "IN_REVIEW", app_store_version_for_review: in_flight_version)

    client = FakeClient.new(
      versions: [in_flight_version],
      submissions: [submission],
      builds: [make_build("0.18.1", "18001999", processing_state: "VALID")],
      submission_poll_states: { "sub-1" => %w[CANCELING COMPLETE] },
      version_poll_states: { "v-1" => %w[IN_REVIEW DEVELOPER_REJECTED] },
    )
    deliver_calls = []

    result = IosReview.submit_review(
      client: client,
      app: @app,
      ui: @ui,
      target_version: "0.18.1",
      target_build: "18001999",
      replace_in_review: true,
      deliver_runner: ->(args) { deliver_calls << args },
      sleep_fn: @sleep_fn,
      clock: @clock,
    )

    assert_equal :submitted, result[:status]
    assert_equal true, result[:reject_if_possible]
    assert_equal ["sub-1"], client.canceled_submission_ids
    assert_equal "DEVELOPER_REJECTED", in_flight_version.app_version_state
    assert_equal [{ app_version: "0.18.1", build_number: "18001999", reject_if_possible: true }], deliver_calls
  end

  def test_submit_review_with_replace_in_review_does_not_cancel_if_replacement_build_is_invalid
    in_flight_version = FakeAppStoreVersion.new(id: "v-1", version_string: "0.18.0", app_version_state: "WAITING_FOR_REVIEW")
    submission = FakeReviewSubmission.new(id: "sub-1", state: "WAITING_FOR_REVIEW", app_store_version_for_review: in_flight_version)

    client = FakeClient.new(
      versions: [in_flight_version],
      submissions: [submission],
      builds: [make_build("0.18.1", "18001999", processing_state: "INVALID")],
    )
    deliver_calls = []

    error = assert_raises(FakeUserError) do
      IosReview.submit_review(
        client: client,
        app: @app,
        ui: @ui,
        target_version: "0.18.1",
        target_build: "18001999",
        replace_in_review: true,
        deliver_runner: ->(args) { deliver_calls << args },
        sleep_fn: @sleep_fn,
        clock: @clock,
      )
    end

    assert_match(/failed App Store processing/, error.message)
    assert_empty client.canceled_submission_ids, "Must not cancel active review if replacement build is INVALID"
    assert_empty deliver_calls
  end

  def test_cancel_review_cancels_active_submission_and_logs_resulting_state
    in_flight_version = FakeAppStoreVersion.new(id: "v-1", version_string: "0.18.0", app_version_state: "WAITING_FOR_REVIEW")
    submission = FakeReviewSubmission.new(id: "sub-99", state: "WAITING_FOR_REVIEW", app_store_version_for_review: in_flight_version)

    client = FakeClient.new(
      versions: [in_flight_version],
      submissions: [submission],
      submission_poll_states: { "sub-99" => %w[CANCELING COMPLETE] },
      version_poll_states: { "v-1" => %w[WAITING_FOR_REVIEW DEVELOPER_REJECTED] },
    )

    result = IosReview.cancel_review(
      client: client,
      app: @app,
      ui: @ui,
      expected_version: "0.18.0",
      sleep_fn: @sleep_fn,
      clock: @clock,
    )

    assert_equal :canceled, result[:status]
    assert_equal "0.18.0", result[:version]
    assert_equal "sub-99", result[:submission_id]
    assert_equal "COMPLETE", result[:submission_state]
    assert_equal "DEVELOPER_REJECTED", result[:version_state]
    assert_equal ["sub-99"], client.canceled_submission_ids
    assert_includes @ui.successes.last, "IOS_REVIEW_CANCELED version=0.18.0 submission_id=sub-99 submission_state=COMPLETE version_state=DEVELOPER_REJECTED"
  end

  def test_cancel_review_refuses_on_expected_version_mismatch
    in_flight_version = FakeAppStoreVersion.new(id: "v-1", version_string: "0.18.1", app_version_state: "IN_REVIEW")
    submission = FakeReviewSubmission.new(id: "sub-99", state: "IN_REVIEW", app_store_version_for_review: in_flight_version)

    client = FakeClient.new(
      versions: [in_flight_version],
      submissions: [submission],
    )

    error = assert_raises(FakeUserError) do
      IosReview.cancel_review(
        client: client,
        app: @app,
        ui: @ui,
        expected_version: "0.18.0",
        sleep_fn: @sleep_fn,
        clock: @clock,
      )
    end

    assert_match(/expected version 0\.18\.0.*version 0\.18\.1/i, error.message)
    assert_empty client.canceled_submission_ids
  end

  def test_cancel_review_exits_cleanly_when_no_review_is_in_flight
    client = FakeClient.new(versions: [], submissions: [])

    result = IosReview.cancel_review(
      client: client,
      app: @app,
      ui: @ui,
      expected_version: "0.18.0",
      sleep_fn: @sleep_fn,
      clock: @clock,
    )

    assert_equal :noop, result[:status]
    assert_empty client.canceled_submission_ids
    assert_includes @ui.messages.first, "IOS_REVIEW_CANCEL_NOOP reason=no_active_review expected_version=0.18.0"
  end

  def test_cancel_review_errors_clearly_when_version_is_already_pending_release
    pending = FakeAppStoreVersion.new(id: "v-1", version_string: "0.18.0", app_version_state: "PENDING_APPLE_RELEASE")
    client = FakeClient.new(versions: [pending], submissions: [])

    error = assert_raises(FakeUserError) do
      IosReview.cancel_review(
        client: client,
        app: @app,
        ui: @ui,
        expected_version: "0.18.0",
        sleep_fn: @sleep_fn,
        clock: @clock,
      )
    end

    assert_match(/Cannot cancel iOS App Store version 0\.18\.0 \(state: PENDING_APPLE_RELEASE\)/, error.message)
    assert_empty client.canceled_submission_ids
  end

  def test_cancel_review_waits_without_duplicate_cancel_when_already_canceling
    in_flight_version = FakeAppStoreVersion.new(id: "v-1", version_string: "0.18.0", app_version_state: "WAITING_FOR_REVIEW")
    submission = FakeReviewSubmission.new(id: "sub-5", state: "CANCELING", app_store_version_for_review: in_flight_version)

    client = FakeClient.new(
      versions: [in_flight_version],
      submissions: [submission],
      submission_poll_states: { "sub-5" => %w[COMPLETE] },
      version_poll_states: { "v-1" => %w[DEVELOPER_REJECTED] },
    )

    result = IosReview.cancel_review(
      client: client,
      app: @app,
      ui: @ui,
      sleep_fn: @sleep_fn,
      clock: @clock,
    )

    assert_equal :canceled, result[:status]
    assert_empty client.canceled_submission_ids
    assert_equal "DEVELOPER_REJECTED", result[:version_state]
  end

  def test_review_status_formats_live_active_submissions_and_top_five_testflight_builds
    live = FakeAppStoreVersion.new(
      id: "v-live",
      version_string: "0.17.1",
      app_version_state: "READY_FOR_DISTRIBUTION",
      build: FakeBuild.new(version: "17001999"),
    )
    active = FakeAppStoreVersion.new(
      id: "v-active",
      version_string: "0.18.0",
      app_version_state: "WAITING_FOR_REVIEW",
      build: FakeBuild.new(version: "18000999"),
    )
    submission = FakeReviewSubmission.new(
      id: "sub-10",
      state: "WAITING_FOR_REVIEW",
      submitted_date: "2026-11-26T12:00:00Z",
      app_store_version_for_review: active,
    )
    builds = [
      make_build("0.18.2", "18002999", processing_state: "PROCESSING", uploaded_date: "2026-11-27T11:00:00Z"),
      make_build("0.18.1", "18001999", processing_state: "VALID", uploaded_date: "2026-11-27T09:00:00Z"),
      make_build("0.18.0", "18000999", processing_state: "VALID", uploaded_date: "2026-11-26T11:30:00Z"),
      make_build("0.18.0", "18000001", processing_state: "VALID", uploaded_date: "2026-11-25T10:00:00Z"),
      make_build("0.17.1", "17001999", processing_state: "VALID", uploaded_date: "2026-11-20T08:00:00Z"),
      make_build("0.17.0", "17000999", processing_state: "VALID", uploaded_date: "2026-11-15T08:00:00Z"),
    ]

    client = FakeClient.new(
      live_version_record: live,
      versions: [live, active],
      submissions: [submission],
      builds: builds,
    )

    result = IosReview.review_status(client: client, app: @app, ui: @ui)
    report = result[:report]

    assert_equal 5, result[:recent_builds].length
    assert_includes report, "=== iOS App Store Review Status (sh.paseo) ==="
    assert_includes report, "version=0.17.1 | state=READY_FOR_DISTRIBUTION | build=17001999"
    assert_includes report, "version=0.18.0 | state=WAITING_FOR_REVIEW | build=18000999"
    assert_includes report, "id=sub-10 | version=0.18.0 | state=WAITING_FOR_REVIEW | submitted_date=2026-11-26T12:00:00Z"
    assert_includes report, "1. version=0.18.2 | build=18002999 | processing_state=PROCESSING | uploaded_date=2026-11-27T11:00:00Z"
    assert_includes report, "5. version=0.17.1 | build=17001999 | processing_state=VALID | uploaded_date=2026-11-20T08:00:00Z"
    refute_includes report, "0.17.0"
  end

  def test_review_status_formats_empty_sections_cleanly
    client = FakeClient.new
    result = IosReview.review_status(client: client, app: @app, ui: @ui)
    report = result[:report]

    assert_equal 4, report.scan("  (none)").length
  end
end
