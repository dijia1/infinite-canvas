package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	_ "github.com/basketikun/infinite-canvas/ai/providers"
	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/internal/lifecycle"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/router"
	"github.com/basketikun/infinite-canvas/service"
)

func main() {
	if err := run(); err != nil {
		log.Printf("[shutdown] application failed: %v", err)
		os.Exit(1)
	}
}

func run() (result error) {
	startup, stopSignals := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stopSignals() // Keep repeated signals consumed until draining completes.
	work, cancelWork := context.WithCancel(context.Background())
	defer cancelWork()
	var stops []func()
	var server *lifecycle.HTTP
	shutdownFinished := make(chan struct{})
	defer close(shutdownFinished)
	quiesce := make(chan os.Signal, 1)
	signal.Notify(quiesce, syscall.SIGUSR1)
	defer signal.Stop(quiesce)
	go func() {
		for {
			select {
			case <-quiesce:
				service.BeginWorkerShutdown()
				log.Print("[shutdown] worker admission closed; HTTP retained for frontend drain")
			case <-shutdownFinished:
				return
			}
		}
	}()
	var requestShutdown sync.Once
	beginShutdown := func() {
		requestShutdown.Do(func() {
			service.BeginWorkerShutdown()
			log.Print("[shutdown] stop requested; worker admission closed")
			go func() {
				timer := time.NewTimer(24 * time.Second)
				defer timer.Stop()
				select {
				case <-shutdownFinished:
				case <-timer.C:
					cancelWork()
					log.Print("[shutdown] deadline exceeded; exiting unsuccessfully")
					os.Exit(1)
				}
			}()
		})
	}
	go func() {
		select {
		case <-startup.Done():
			beginShutdown()
		case <-shutdownFinished:
		}
	}()

	defer func() {
		beginShutdown()
		log.Print("[shutdown] draining HTTP and workers")
		httpError := make(chan error, 1)
		var drains sync.WaitGroup
		if server != nil {
			drains.Add(1)
			go func() {
				defer drains.Done()
				// The signal timer is the absolute budget, including any startup work.
				if err := server.Shutdown(work); err != nil {
					httpError <- err
				}
			}()
		}
		for _, stop := range stops {
			drains.Add(1)
			go func(stop func()) { defer drains.Done(); stop() }(stop)
		}
		drains.Wait()
		select {
		case err := <-httpError:
			result = errors.Join(result, err)
		default:
		}
		if err := repository.CloseDatabase(); err != nil {
			result = errors.Join(result, err)
		} else {
			log.Print("[shutdown] database pool closed")
		}
		log.Print("[shutdown] complete")
	}()
	if err := config.Load(); err != nil {
		return err
	}
	log.Print("waiting for database before application initialization")
	databaseContext, cancelWait := context.WithTimeout(startup, 60*time.Second)
	err := repository.WaitForDatabase(databaseContext, config.Cfg.DatabaseDSN)
	cancelWait()
	if startup.Err() != nil {
		return nil
	}
	if err != nil {
		return err
	}
	for _, start := range []func(context.Context) (func(), error){service.StartImageTaskWorker, service.StartVideoTaskWorker, service.StartWorkflowScheduler} {
		if startup.Err() != nil {
			return nil
		}
		stop, err := start(work)
		if err != nil {
			return err
		}
		stops = append(stops, stop)
	}
	for _, start := range []func(context.Context) func(){service.StartOperationLogRetention, service.StartCanvasSaveRequestRetention, service.StartMediaUploadIntentRetention, service.StartCanvasMediaRetention} {
		if startup.Err() != nil {
			return nil
		}
		stops = append(stops, start(work))
	}
	if startup.Err() != nil {
		return nil
	}
	server = lifecycle.NewHTTP(":"+config.Cfg.Port, router.New())
	serveError := make(chan error, 1)
	go func() { serveError <- server.Server.ListenAndServe() }()
	select {
	case <-startup.Done():
		return nil
	case err := <-serveError:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}
