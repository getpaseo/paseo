/* glog configuration for MSVC on Windows.
 *
 * ReactAndroid ships an Autoconf config.h generated on Android/Linux, and
 * glog 0.3.5 predates MSVC support in its own build system, so the Windows
 * answers are provided here instead of reusing those POSIX results. Anything
 * not defined here is deliberately absent: no <unistd.h>, <sys/time.h>,
 * <sys/utsname.h> or <unwind.h>, no __sync builtins, no GNU __attribute__,
 * no __builtin_expect, no execinfo/glob/pwd/sigaction/sigaltstack/syslog and
 * no pread or pthreads.
 */
/* No HAVE_FCNTL: MSVC's <fcntl.h> lacks F_SETFD/FD_CLOEXEC, and glog's
 * fopen fallback is the Windows path. */
#define HAVE_INTTYPES_H 1
#define HAVE_SNPRINTF 1
#define HAVE_STDINT_H 1
#define HAVE_STRING_H 1
#define HAVE_SYS_STAT_H 1
#define HAVE_SYS_TYPES_H 1
#define HAVE_TIME_H 1
#define HAVE_USING_OPERATOR 1

/* glog's headers wrap their declarations in these namespace macros. */
#define _START_GOOGLE_NAMESPACE_ namespace google {
#define _END_GOOGLE_NAMESPACE_ }

#define STL_NAMESPACE std

/* ReactAndroid's android-* builds are 32-bit; this one is 64-bit. */
#define SIZEOF_VOID_P 8

#define PACKAGE "glog"
#define PACKAGE_VERSION "0.3.5"
#define VERSION "0.3.5"
