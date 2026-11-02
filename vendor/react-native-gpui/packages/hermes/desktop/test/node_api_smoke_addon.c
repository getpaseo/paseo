#include <node_api.h>
#include <stdlib.h>

// Both platform helpers below hand this function to the thread they create, and
// it is defined further down, so it has to be declared before either branch:
// Windows' adapter calls it and the POSIX branch passes it to `pthread_create`.
// Declaring it inside the Windows branch left the POSIX branch using it
// undeclared, which does not compile.
static void* run_threadsafe_call(void* data);

#if defined(_WIN32)
// Windows has no pthreads. The thread here only exists to prove the
// ThreadSafeFunction crosses a real thread boundary, so a Win32 thread is
// enough. Its entry point returns DWORD rather than void*, so the body is
// shared through a small adapter instead of casting the function pointer (which
// would be undefined behaviour on a calling-convention or return-type change).
#include <windows.h>
typedef HANDLE smoke_thread_t;
static DWORD WINAPI smoke_thread_entry(LPVOID arg) {
  run_threadsafe_call(arg);
  return 0;
}
static int smoke_thread_create(smoke_thread_t* thread, void* arg) {
  *thread = CreateThread(NULL, 0, smoke_thread_entry, arg, 0, NULL);
  return *thread == NULL ? -1 : 0;
}
static void smoke_thread_detach(smoke_thread_t thread) {
  CloseHandle(thread);
}
#else
#include <pthread.h>
typedef pthread_t smoke_thread_t;
static int smoke_thread_create(smoke_thread_t* thread, void* arg) {
  return pthread_create(thread, NULL, run_threadsafe_call, arg);
}
static void smoke_thread_detach(smoke_thread_t thread) {
  pthread_detach(thread);
}
#endif

typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  int32_t left;
  int32_t right;
  int32_t result;
} AddWork;

typedef struct {
  napi_threadsafe_function function;
} ThreadsafeWork;

static napi_value add(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok ||
      argc != 2) {
    return NULL;
  }

  int32_t left = 0;
  int32_t right = 0;
  if (napi_get_value_int32(env, args[0], &left) != napi_ok ||
      napi_get_value_int32(env, args[1], &right) != napi_ok) {
    return NULL;
  }

  napi_value result = NULL;
  if (napi_create_int32(env, left + right, &result) != napi_ok) {
    return NULL;
  }
  return result;
}

static void execute_add(napi_env env, void* data) {
  (void)env;
  AddWork* work = (AddWork*)data;
  work->result = work->left + work->right;
}

static void complete_add(napi_env env, napi_status status, void* data) {
  AddWork* work = (AddWork*)data;
  napi_value result = NULL;
  if (status == napi_ok &&
      napi_create_int32(env, work->result, &result) == napi_ok) {
    napi_resolve_deferred(env, work->deferred, result);
  } else {
    napi_value error = NULL;
    napi_create_error(env, NULL, NULL, &error);
    napi_reject_deferred(env, work->deferred, error);
  }
  napi_delete_async_work(env, work->work);
  free(work);
}

static napi_value async_add(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  int32_t left = 0;
  int32_t right = 0;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok ||
      argc != 2 || napi_get_value_int32(env, args[0], &left) != napi_ok ||
      napi_get_value_int32(env, args[1], &right) != napi_ok) {
    return NULL;
  }
  AddWork* work = (AddWork*)calloc(1, sizeof(AddWork));
  if (work == NULL) {
    return NULL;
  }
  work->left = left;
  work->right = right;

  napi_value promise = NULL;
  napi_value resource_name = NULL;
  if (napi_create_promise(env, &work->deferred, &promise) != napi_ok ||
      napi_create_string_utf8(
          env, "node-api-smoke", NAPI_AUTO_LENGTH, &resource_name) != napi_ok ||
      napi_create_async_work(
          env,
          NULL,
          resource_name,
          execute_add,
          complete_add,
          work,
          &work->work) != napi_ok ||
      napi_queue_async_work(env, work->work) != napi_ok) {
    free(work);
    return NULL;
  }
  return promise;
}

static void
call_js(napi_env env, napi_value callback, void* context, void* data) {
  (void)context;
  int32_t* value = (int32_t*)data;
  if (env != NULL && callback != NULL && value != NULL) {
    napi_value global = NULL;
    napi_value argument = NULL;
    if (napi_get_global(env, &global) == napi_ok &&
        napi_create_int32(env, *value, &argument) == napi_ok) {
      napi_call_function(env, global, callback, 1, &argument, NULL);
    }
  }
  free(value);
}

static void* run_threadsafe_call(void* data) {
  ThreadsafeWork* work = (ThreadsafeWork*)data;
  int32_t* value = (int32_t*)malloc(sizeof(int32_t));
  if (value != NULL) {
    *value = 42;
    if (napi_call_threadsafe_function(
            work->function, value, napi_tsfn_nonblocking) != napi_ok) {
      free(value);
    }
  }
  napi_release_threadsafe_function(work->function, napi_tsfn_release);
  free(work);
  return NULL;
}

static napi_value threadsafe_ping(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok ||
      argc != 1) {
    return NULL;
  }

  napi_value resource_name = NULL;
  if (napi_create_string_utf8(
          env, "node-api-smoke-tsfn", NAPI_AUTO_LENGTH, &resource_name) !=
      napi_ok) {
    return NULL;
  }
  ThreadsafeWork* work = (ThreadsafeWork*)calloc(1, sizeof(ThreadsafeWork));
  if (work == NULL ||
      napi_create_threadsafe_function(
          env,
          args[0],
          NULL,
          resource_name,
          0,
          1,
          NULL,
          NULL,
          NULL,
          call_js,
          &work->function) != napi_ok) {
    free(work);
    return NULL;
  }

  smoke_thread_t thread;
  if (smoke_thread_create(&thread, work) != 0) {
    napi_release_threadsafe_function(work->function, napi_tsfn_abort);
    free(work);
    return NULL;
  }
  smoke_thread_detach(thread);
  napi_value result = NULL;
  napi_get_undefined(env, &result);
  return result;
}

NAPI_MODULE_INIT() {
  napi_property_descriptor descriptors[] = {
      {"add", NULL, add, NULL, NULL, NULL, napi_default, NULL},
      {"asyncAdd", NULL, async_add, NULL, NULL, NULL, napi_default, NULL},
      {"threadsafePing",
       NULL,
       threadsafe_ping,
       NULL,
       NULL,
       NULL,
       napi_default,
       NULL},
  };
  if (napi_define_properties(env, exports, 3, descriptors) != napi_ok) {
    return NULL;
  }
  return exports;
}
