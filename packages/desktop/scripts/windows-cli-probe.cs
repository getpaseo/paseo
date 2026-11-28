using System;
using System.IO;
using System.Text;

static class Program
{
    static int Main(string[] args)
    {
        string outPath = Environment.GetEnvironmentVariable("PASEO_PROBE_OUT");
        StringBuilder body = new StringBuilder();
        body.Append("ELECTRON_RUN_AS_NODE=").Append(Environment.GetEnvironmentVariable("ELECTRON_RUN_AS_NODE")).Append('\n');
        body.Append("PASEO_NODE_ENV=").Append(Environment.GetEnvironmentVariable("PASEO_NODE_ENV")).Append('\n');
        body.Append("PASEO_CLI=").Append(Environment.GetEnvironmentVariable("PASEO_CLI")).Append('\n');
        body.Append("COUNT=").Append(args.Length).Append('\n');
        for (int index = 0; index < args.Length; index++)
        {
            body.Append("ARG").Append(index).Append('=');
            body.Append(Convert.ToBase64String(Encoding.UTF8.GetBytes(args[index])));
            body.Append('\n');
        }
        int exitCode = 0;
        if (Environment.GetEnvironmentVariable("PASEO_PROBE_STDIO") == "1")
        {
            string stdinText = Console.In.ReadToEnd();
            Console.Out.Write("stdout-marker\n");
            Console.Out.Write(stdinText);
            Console.Out.Flush();
            Console.Error.Write("stderr-marker\n");
            Console.Error.Flush();
            body.Append("STDIN=").Append(Convert.ToBase64String(Encoding.UTF8.GetBytes(stdinText))).Append('\n');
            exitCode = 7;
        }
        File.WriteAllText(outPath, body.ToString(), new UTF8Encoding(false));
        return exitCode;
    }
}
