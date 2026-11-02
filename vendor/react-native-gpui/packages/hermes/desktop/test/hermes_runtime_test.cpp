#include <hermes/hermes.h>
#include <jsi/jsi.h>

#include <fstream>
#include <iostream>
#include <iterator>
#include <memory>
#include <string>

int main(int argc, char** argv) {
  auto runtime = facebook::hermes::makeHermesRuntime();

  std::string source = "40 + 2";
  if (argc > 1) {
    std::ifstream bytecode(argv[1], std::ios::binary);
    if (!bytecode) {
      std::cerr << "failed to open bytecode file: " << argv[1] << std::endl;
      return 2;
    }
    source.assign(
        std::istreambuf_iterator<char>(bytecode),
        std::istreambuf_iterator<char>());
  }
  auto script =
      std::make_shared<facebook::jsi::StringBuffer>(std::move(source));
  facebook::jsi::Value result =
      runtime->evaluateJavaScript(script, "hermes_runtime_test");

  std::cout << "hermes evaluated 40 + 2 = " << result.getNumber() << std::endl;
  return result.getNumber() == 42.0 ? 0 : 1;
}
