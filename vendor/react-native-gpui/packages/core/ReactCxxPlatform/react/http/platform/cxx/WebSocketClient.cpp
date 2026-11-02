/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "WebSocketClient.h"

#include <boost/asio/ssl.hpp>
#include <boost/beast/core.hpp>
#include <boost/beast/ssl.hpp>
#include <boost/beast/websocket.hpp>
#include <folly/Synchronized.h>
#include <folly/Uri.h>
#include <folly/system/ThreadName.h>
#include <openssl/ssl.h>
#include <openssl/x509.h>
#include <react/debug/react_native_assert.h>
#include <atomic>
#include <mutex>
#include <queue>
#include <variant>
#if defined(__APPLE__)
#include <Security/Security.h>
#endif
#if defined(_WIN32)
#include <openssl/err.h>
#include <openssl/x509.h>
#include <wincrypt.h>
#include <windows.h>
#endif

namespace facebook::react {

namespace {
std::atomic<uint64_t> webSocketMessagesInFlight{0};

using PlainWebSocket =
    boost::beast::websocket::stream<boost::asio::ip::tcp::socket>;
using TlsWebSocket = boost::beast::websocket::stream<
    boost::beast::ssl_stream<boost::asio::ip::tcp::socket>>;
using AnyWebSocket = std::variant<PlainWebSocket, TlsWebSocket>;

#if defined(__APPLE__)
bool verifyWithMacSystemTrust(
    const std::string& hostname,
    X509_STORE_CTX* storeContext) {
  CFMutableArrayRef certificates =
      CFArrayCreateMutable(kCFAllocatorDefault, 0, &kCFTypeArrayCallBacks);
  if (certificates == nullptr) {
    return false;
  }

  auto* chain = X509_STORE_CTX_get0_chain(storeContext);
  const int certificateCount = chain == nullptr ? 0 : sk_X509_num(chain);
  for (int index = 0; index < certificateCount; ++index) {
    auto* certificate = sk_X509_value(chain, index);
    const int encodedSize = i2d_X509(certificate, nullptr);
    if (encodedSize <= 0) {
      CFRelease(certificates);
      return false;
    }
    std::vector<unsigned char> encoded(static_cast<size_t>(encodedSize));
    auto* encodedCursor = encoded.data();
    i2d_X509(certificate, &encodedCursor);
    CFDataRef data = CFDataCreate(
        kCFAllocatorDefault,
        encoded.data(),
        static_cast<CFIndex>(encoded.size()));
    SecCertificateRef secCertificate =
        SecCertificateCreateWithData(kCFAllocatorDefault, data);
    CFRelease(data);
    if (secCertificate == nullptr) {
      CFRelease(certificates);
      return false;
    }
    CFArrayAppendValue(certificates, secCertificate);
    CFRelease(secCertificate);
  }

  CFStringRef host = CFStringCreateWithCString(
      kCFAllocatorDefault, hostname.c_str(), kCFStringEncodingUTF8);
  SecPolicyRef policy = SecPolicyCreateSSL(true, host);
  CFRelease(host);
  SecTrustRef trust = nullptr;
  const auto createStatus =
      SecTrustCreateWithCertificates(certificates, policy, &trust);
  CFRelease(policy);
  CFRelease(certificates);
  if (createStatus != errSecSuccess || trust == nullptr) {
    return false;
  }
  const bool trusted = SecTrustEvaluateWithError(trust, nullptr);
  CFRelease(trust);
  return trusted;
}
#endif

#if defined(_WIN32)
void loadWindowsSystemRoots(boost::asio::ssl::context& context) {
  const DWORD scopes[] = {
      CERT_SYSTEM_STORE_CURRENT_USER, CERT_SYSTEM_STORE_LOCAL_MACHINE};
  for (const auto scope : scopes) {
    HCERTSTORE store = CertOpenStore(
        CERT_STORE_PROV_SYSTEM_W,
        0,
        0,
        scope | CERT_STORE_OPEN_EXISTING_FLAG | CERT_STORE_READONLY_FLAG,
        L"ROOT");
    if (store == nullptr) {
      continue;
    }
    PCCERT_CONTEXT certificateContext = nullptr;
    while ((certificateContext = CertEnumCertificatesInStore(
                store, certificateContext)) != nullptr) {
      const unsigned char* encoded = certificateContext->pbCertEncoded;
      X509* certificate = d2i_X509(
          nullptr,
          &encoded,
          static_cast<long>(certificateContext->cbCertEncoded));
      if (certificate != nullptr) {
        X509_STORE_add_cert(
            SSL_CTX_get_cert_store(context.native_handle()), certificate);
        X509_free(certificate);
        ERR_clear_error(); // Ignore duplicate certificates in the store.
      }
    }
    CertCloseStore(store, 0);
  }
}
#endif
} // namespace

extern "C" uint64_t rn_gpui_websocket_messages_in_flight() noexcept {
  return webSocketMessagesInFlight.load(std::memory_order_relaxed);
}

struct WebSocketClient::Impl final : public std::enable_shared_from_this<Impl> {
  void onResolveCompleted(
      boost::system::error_code ec,
      const boost::asio::ip::tcp::resolver::results_type& results);

  void onConnectionCompleted(boost::system::error_code ec);

  void onTlsHandshakeCompleted(boost::system::error_code ec);

  void onHandshakeCompleted(boost::system::error_code ec);

  void listen();

  void write();

  void onConnectCallback(bool connected, const std::string& error);
  void onClosed(uint16_t code, const std::string& reason);

  // Callbacks and Uri
  OnConnectCallback onConnectCallback_;
  OnClosedCallback onClosedCallback_;
  OnMessageCallback onMessageCallback_;
  OnMessageFrameCallback onMessageFrameCallback_;
  OnClosedFrameCallback onClosedFrameCallback_;
  std::optional<folly::Uri> uri_;

  // Boost Beast WebSocket Client
  boost::asio::io_context ioContext_;
  boost::asio::ip::tcp::resolver resolver_{ioContext_};
  boost::beast::multi_buffer buffer_;
  boost::asio::ssl::context tlsContext_{boost::asio::ssl::context::tls_client};
  folly::Synchronized<AnyWebSocket> ws_{
      AnyWebSocket{PlainWebSocket{ioContext_}}};

  // Input and Output handling
  std::mutex mutexOut_;
  std::queue<std::pair<std::string, bool>> messagesOut_;
  std::atomic<bool> isWriting_{false};
  std::atomic<bool> isClosing_{false};
  std::atomic<bool> didReportClosed_{false};
};

WebSocketClient::WebSocketClient() noexcept
    : impl_(std::make_shared<WebSocketClient::Impl>()) {}

WebSocketClient::~WebSocketClient() {
  WebSocketClient::close("Force close as WebSocketClient being destroyed");
}

void WebSocketClient::setOnClosedCallback(
    OnClosedCallback&& callback) noexcept {
  impl_->onClosedCallback_ = std::move(callback);
}

void WebSocketClient::setOnMessageCallback(
    OnMessageCallback&& callback) noexcept {
  impl_->onMessageCallback_ = std::move(callback);
}

void WebSocketClient::setOnMessageFrameCallback(
    OnMessageFrameCallback&& callback) noexcept {
  impl_->onMessageFrameCallback_ = std::move(callback);
}

void WebSocketClient::setOnClosedFrameCallback(
    OnClosedFrameCallback&& callback) noexcept {
  impl_->onClosedFrameCallback_ = std::move(callback);
}

void WebSocketClient::connect(
    const std::string& url,
    OnConnectCallback&& callback) {
  if (thread_) {
    react_native_assert(false && "WebSocketClient::connect() called twice");
    return;
  }

  impl_->onConnectCallback_ = std::move(callback);
  impl_->uri_ = folly::Uri{url};
  // React Native hands its own clients http(s) URLs (Metro's HMR client opens
  // `http://host:port/hot`) and every platform's socket takes them as ws(s).
  if (impl_->uri_->scheme() == "http") {
    impl_->uri_ = folly::Uri{"ws" + url.substr(4)};
  } else if (impl_->uri_->scheme() == "https") {
    impl_->uri_ = folly::Uri{"wss" + url.substr(5)};
  }
  if (impl_->uri_->scheme() != "ws" && impl_->uri_->scheme() != "wss") {
    impl_->onConnectCallback(false, "WebSocket URL must use ws:// or wss://");
    return;
  }
  if (impl_->uri_->scheme() == "wss") {
    try {
      impl_->tlsContext_.set_default_verify_paths();
    } catch (const std::exception& error) {
      LOG(WARNING) << "[gpui-ws] OpenSSL default trust paths unavailable: "
                   << error.what();
    }
    impl_->tlsContext_.set_verify_mode(boost::asio::ssl::verify_peer);
#if defined(_WIN32)
    loadWindowsSystemRoots(impl_->tlsContext_);
#endif
    auto ws = impl_->ws_.wlock();
    ws->emplace<TlsWebSocket>(impl_->ioContext_, impl_->tlsContext_);
    auto& tls = std::get<TlsWebSocket>(*ws);
    const auto hostname = impl_->uri_->hostname();
    tls.next_layer().set_verify_callback(
        [hostname](
            bool preverified, boost::asio::ssl::verify_context& verifyContext) {
          if (boost::asio::ssl::host_name_verification(hostname)(
                  preverified, verifyContext)) {
            return true;
          }
#if defined(__APPLE__)
          return verifyWithMacSystemTrust(
              hostname, verifyContext.native_handle());
#else
          return false;
#endif
        });
    if (SSL_set_tlsext_host_name(
            tls.next_layer().native_handle(),
            impl_->uri_->hostname().c_str()) != 1) {
      impl_->onConnectCallback(false, "Could not configure TLS server name");
      return;
    }
  }

  // Resolve the domain name
  impl_->resolver_.async_resolve(
      impl_->uri_->hostname(),
      std::to_string(
          impl_->uri_->port() == 0 ? (impl_->uri_->scheme() == "wss" ? 443 : 80)
                                   : impl_->uri_->port()),
      [weakImpl = std::weak_ptr(impl_)](
          boost::system::error_code ec,
          const boost::asio::ip::tcp::resolver::results_type& results) {
        if (auto impl = weakImpl.lock()) {
          impl->onResolveCompleted(ec, results);
        }
      });

  // Start the I/O thread
  static int32_t s_threadId = 0;
  thread_ = std::make_unique<std::thread>(
      [weakImpl = std::weak_ptr(impl_), tid = s_threadId++]() {
        folly::setThreadName("WebSocket" + std::to_string(tid));
        if (auto impl = weakImpl.lock()) {
          impl->ioContext_.run();
        }
      });
}

void WebSocketClient::close(const std::string& reason) {
  close(1000, reason);
}

void WebSocketClient::close(uint16_t code, const std::string& reason) {
  if (!impl_->isClosing_.exchange(true)) {
    impl_->onClosed(code, reason);
    {
      std::lock_guard<std::mutex> lock(impl_->mutexOut_);
      const auto queued = impl_->messagesOut_.size();
      while (!impl_->messagesOut_.empty()) impl_->messagesOut_.pop();
      if (queued > 0)
        webSocketMessagesInFlight.fetch_sub(queued, std::memory_order_relaxed);
    }
    {
      auto ws = impl_->ws_.wlock();
      std::visit(
          [code, &reason](auto& socket) {
            if (socket.is_open()) {
              boost::beast::websocket::close_reason closeReason;
              closeReason.code =
                  static_cast<boost::beast::websocket::close_code>(code);
              closeReason.reason = reason;
              socket.async_close(closeReason, [](auto&&) {});
            } else {
              boost::system::error_code ignored;
              boost::beast::get_lowest_layer(socket).close(ignored);
            }
          },
          *ws);
    }
    // Outside the lock: the I/O thread takes it in every completion handler,
    // so joining while holding it deadlocks against a connection that is
    // still being set up.
    if (thread_) {
      thread_->join();
    }
  }
  thread_ = nullptr;
}

void WebSocketClient::send(const std::string& message) {
  {
    std::lock_guard<std::mutex> lock(impl_->mutexOut_);
    if (impl_->isClosing_) return;
    impl_->messagesOut_.emplace(message, false);
    webSocketMessagesInFlight.fetch_add(1, std::memory_order_relaxed);
  }
  impl_->write();
}

void WebSocketClient::sendBinary(const std::string& bytes) {
  {
    std::lock_guard<std::mutex> lock(impl_->mutexOut_);
    if (impl_->isClosing_) return;
    impl_->messagesOut_.emplace(bytes, true);
    webSocketMessagesInFlight.fetch_add(1, std::memory_order_relaxed);
  }
  impl_->write();
}

void WebSocketClient::ping() {
  auto ws = impl_->ws_.wlock();
  std::visit(
      [weakImpl = std::weak_ptr(impl_)](auto& socket) {
        socket.async_ping({}, [weakImpl](boost::beast::error_code ec) {
          auto impl = weakImpl.lock();
          if (!impl || impl->isClosing_) {
            return;
          }
          if (ec) {
            LOG(ERROR) << "Error pinging websocket: " << ec.message();
          }
        });
      },
      *ws);
}

void WebSocketClient::Impl::onResolveCompleted(
    boost::system::error_code ec,
    const boost::asio::ip::tcp::resolver::results_type& results) {
  if (ec) {
    // TODO: Handle retry logic here
    onConnectCallback(false, "Failed to resolve host");
    return;
  }
  if (isClosing_) {
    // `close()` already closed the socket; connecting now would reopen it and
    // keep `close()` waiting on this thread until the attempt fails.
    return;
  }

  auto ws = ws_.wlock();
  std::visit(
      [weakImpl = weak_from_this(), &results](auto& socket) {
        boost::asio::async_connect(
            boost::beast::get_lowest_layer(socket),
            results.begin(),
            results.end(),
            [weakImpl](boost::system::error_code connectError, const auto&) {
              if (auto impl = weakImpl.lock()) {
                impl->onConnectionCompleted(connectError);
              }
            });
      },
      *ws);
}

void WebSocketClient::Impl::onConnectionCompleted(
    boost::system::error_code ec) {
  if (ec) {
    // TODO: Handle retry logic here
    onConnectCallback(false, "Failed to connect");
    return;
  }

  {
    auto ws = ws_.wlock();
    if (std::holds_alternative<TlsWebSocket>(*ws)) {
      std::get<TlsWebSocket>(*ws).next_layer().async_handshake(
          boost::asio::ssl::stream_base::client,
          [weakImpl =
               weak_from_this()](boost::system::error_code handshakeError) {
            if (auto impl = weakImpl.lock()) {
              impl->onTlsHandshakeCompleted(handshakeError);
            }
          });
      return;
    }
  }
  // Outside the lock: `onTlsHandshakeCompleted` takes it again, and it is not
  // recursive, so a plain ws:// connection would stop here for good.
  onTlsHandshakeCompleted({});
}

void WebSocketClient::Impl::onTlsHandshakeCompleted(
    boost::system::error_code ec) {
  if (ec) {
    onConnectCallback(false, "TLS handshake failed: " + ec.message());
    onClosed(1006, ec.message());
    return;
  }
  auto ws = ws_.wlock();
  // https://datatracker.ietf.org/doc/html/rfc6455#section-3:
  // > The "resource-name" (also known as /resource name/ in
  // > https://datatracker.ietf.org/doc/html/rfc6455#section-4.1)
  // > can be constructed by concatenating the following:
  // >
  // > o  "/" if the path component is empty
  // >
  // > o  the path component
  // >
  // > o  "?" if the query component is non-empty
  // >
  // > o  the query component
  auto resourceName = (uri_->path().empty() ? "/" : uri_->path()) +
      (uri_->query().empty() ? "" : "?" + uri_->query());
  // Perform the websocket handshake
  const auto port =
      uri_->port() == 0 ? (uri_->scheme() == "wss" ? 443 : 80) : uri_->port();
  const auto host = uri_->host() + ":" + std::to_string(port);
  std::visit(
      [weakImpl = weak_from_this(), host, resourceName](auto& socket) {
        socket.async_handshake(
            host,
            resourceName,
            [weakImpl](boost::system::error_code handshakeError) {
              if (auto impl = weakImpl.lock()) {
                impl->onHandshakeCompleted(handshakeError);
              }
            });
      },
      *ws);
}

void WebSocketClient::Impl::onHandshakeCompleted(boost::system::error_code ec) {
  if (ec) {
    // TODO: Handle retry logic here
    onConnectCallback(false, "Failed to handshake");
    return;
  }

  onConnectCallback(true, "Connected");
  // Listen for any messages from the server
  listen();

  // Start writing any buffered messages
  write();
}

void WebSocketClient::Impl::listen() {
  if (isClosing_) {
    return;
  }
  auto ws = ws_.wlock();
  std::visit(
      [this, weakImpl = weak_from_this()](auto& socket) {
        socket.async_read(
            buffer_,
            [weakImpl](
                boost::beast::error_code ec, std::size_t bytes_transferred) {
              auto impl = weakImpl.lock();
              if (!impl || impl->isClosing_) {
                return;
              }
              if (ec) {
                if (ec == boost::beast::websocket::error::closed) {
                  auto ws = impl->ws_.rlock();
                  const auto& reason = std::visit(
                      [](const auto& current) -> const auto& {
                        return current.reason();
                      },
                      *ws);
                  impl->onClosed(
                      static_cast<uint16_t>(reason.code),
                      std::string(reason.reason.data(), reason.reason.size()));
                } else {
                  LOG(ERROR)
                      << "Error reading from websocket: " << ec.message();
                  impl->onClosed(1006, ec.message());
                }
                return;
              }
              std::string message(
                  boost::beast::buffers_to_string(impl->buffer_.data()));
              const bool isBinary = std::visit(
                  [](const auto& current) { return !current.got_text(); },
                  *impl->ws_.rlock());
              if (impl->onMessageCallback_) {
                impl->onMessageCallback_(message);
              }
              if (impl->onMessageFrameCallback_) {
                impl->onMessageFrameCallback_(message, isBinary);
              }
              impl->buffer_.consume(bytes_transferred);
              impl->listen();
            });
      },
      *ws);
}

void WebSocketClient::Impl::write() {
  if (isClosing_) {
    return;
  }
  if (isWriting_) {
    return;
  }
  isWriting_ = true;

  std::shared_ptr<std::pair<std::string, bool>> message;
  {
    std::lock_guard<std::mutex> lock(mutexOut_);
    if (!messagesOut_.empty()) {
      message =
          std::make_shared<std::pair<std::string, bool>>(messagesOut_.front());
      messagesOut_.pop();
    }
  }

  if (!message) {
    isWriting_ = false;
    return;
  }

  auto ws = ws_.wlock();
  std::visit(
      [message, weakImpl = weak_from_this()](auto& socket) {
        socket.binary(message->second);
        socket.async_write(
            boost::beast::net::buffer(message->first),
            [message, weakImpl](
                boost::beast::error_code ec,
                std::size_t /*bytes_transferred*/) mutable {
              webSocketMessagesInFlight.fetch_sub(1, std::memory_order_relaxed);
              auto impl = weakImpl.lock();
              if (!impl) {
                return;
              }
              if (ec) {
                LOG(ERROR) << "Error writing to websocket: " << ec.message();
                impl->isWriting_ = false;
                return;
              }
              impl->isWriting_ = false;
              if (!impl->isClosing_) impl->write();
              message.reset(); // Release the message after it's been sent
            });
      },
      *ws);
}

void WebSocketClient::Impl::onConnectCallback(
    bool connected,
    const std::string& error) {
  if (!connected) {
    LOG(WARNING) << "WebSocket " << (uri_ ? uri_->host() : "") << " did not connect: " << error;
  }
  if (onConnectCallback_) {
    onConnectCallback_(connected, error);
  }
}

void WebSocketClient::Impl::onClosed(uint16_t code, const std::string& reason) {
  if (didReportClosed_.exchange(true)) {
    return;
  }
  if (onClosedFrameCallback_) {
    onClosedFrameCallback_(code, reason);
  }
  if (onClosedCallback_) {
    onClosedCallback_(reason);
  }
}

WebSocketClientFactory getWebSocketClientFactory() {
  return []() { return std::make_unique<WebSocketClient>(); };
}

} // namespace facebook::react
