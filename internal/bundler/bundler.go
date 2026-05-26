package bundler

import (
	"fmt"

	"github.com/evanw/esbuild/pkg/api"
)

type BundleOptions struct {
	EntryPoints []string
	OutDir      string
	IsProd      bool
}

func Build(opts BundleOptions) error {
	sourcemap := api.SourceMapInline
	if opts.IsProd {
		sourcemap = api.SourceMapNone
	}
	result := api.Build(api.BuildOptions{
		EntryPoints:       opts.EntryPoints,
		Bundle:            true,
		Outdir:            opts.OutDir,
		Write:             true,
		MinifyWhitespace:  opts.IsProd,
		MinifyIdentifiers: opts.IsProd,
		MinifySyntax:      opts.IsProd,
		Sourcemap:         sourcemap,
		Loader: map[string]api.Loader{
			".js":  api.LoaderJSX,
			".jsx": api.LoaderJSX,
			".ts":  api.LoaderTS,
			".tsx": api.LoaderTSX,
		},
		Define: map[string]string{
			"process.env.NODE_ENV": fmt.Sprintf("\"%s\"", envString(opts.IsProd)),
		},
		Banner: map[string]string{
			"js": TextEncoderPolyfill + ProcessPolyfill + MessageChannelPolyfill + URLPolyfill,
		},
	})

	if len(result.Errors) > 0 {
		return fmt.Errorf("build failed: %s", result.Errors[0].Text)
	}

	return nil
}

func envString(isProd bool) string {
	if isProd {
		return "production"
	}
	return "development"
}
