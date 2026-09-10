// loadtest is an isolated test host and HTTP workload driver, never a production entrypoint.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"time"
)

type manifest struct {
	URL   string    `json:"url"`
	PID   int       `json:"pid"`
	Users []fixture `json:"users"`
}

type fixture struct {
	UID        string   `json:"uid"`
	CanvasIDs  []string `json:"canvasIds"`
	WorkflowID string   `json:"workflowId"`
	RunID      string   `json:"runId"`
}

func main() {
	mode := flag.String("mode", "", "server or client")
	path := flag.String("manifest", "", "owned test server manifest")
	out := flag.String("out", "", "result directory")
	users := flag.Int("users", 10, "concurrent virtual users (2-50)")
	ramp := flag.Duration("ramp", 30*time.Second, "ramp up")
	hold := flag.Duration("hold", 3*time.Minute, "steady state")
	down := flag.Duration("down", 30*time.Second, "ramp down")
	flag.Parse()
	if *path == "" || *out == "" {
		log.Fatal("manifest and out are required")
	}
	if err := os.MkdirAll(*out, 0700); err != nil {
		log.Fatal(err)
	}
	var err error
	switch *mode {
	case "server":
		err = serve(*path, *out)
	case "client":
		if *users < 2 || *users > 50 || *ramp <= 0 || *hold <= 0 || *down <= 0 {
			log.Fatal("invalid workload bounds")
		}
		err = drive(*path, *out, *users, *ramp, *hold, *down)
	default:
		err = fmt.Errorf("mode must be server or client")
	}
	if err != nil {
		log.Fatal(err)
	}
}

func writeJSON(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0600)
}
