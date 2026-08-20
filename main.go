package main

import (
	"context"
	"flag"
	"fmt"
	"os"
)

func main() {
	dump := flag.Bool("dump-acp", false, "print every ACP frame and exit after one prompt")
	flag.Parse()

	if *dump {
		if err := dumpACP(flag.Arg(0)); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
}

// dumpACP drives one real turn and prints what came back, so the structs in
// acp.go can be checked against a live adapter rather than against the spec.
func dumpACP(prompt string) error {
	cwd, _ := os.Getwd()
	c, err := Dial(context.Background(), []string{"npx", "@zed-industries/claude-code-acp"}, cwd)
	if err != nil {
		return err
	}
	defer c.Close()
	id, err := c.NewSession(cwd)
	if err != nil {
		return err
	}
	go func() {
		for p := range c.Perms {
			fmt.Printf("PERM  %s %+v\n", p.Title, p.Options)
			p.Reply <- p.Options[0].ID
		}
	}()
	go func() {
		for u := range c.Updates {
			fmt.Printf("UPD   %-24s %s\n", u.Kind, string(u.Raw))
		}
	}()
	stop, err := c.Prompt(id, prompt)
	fmt.Println("STOP", stop)
	return err
}
