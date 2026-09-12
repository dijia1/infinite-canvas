package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/service"
	"gorm.io/gorm"
)

func canvasDocument(uid string, count, sequence int) json.RawMessage {
	nodes, connections := []any{}, []any{}
	for i := 0; i < count; i++ {
		kind := []string{"image", "text", "config", "image"}[i%4]
		metadata := map[string]any{}
		switch kind {
		case "image":
			metadata["mediaId"] = fmt.Sprintf("%s-media-%03d", uid, i%100)
		case "text":
			metadata["content"] = strings.Repeat("压测提示词，保留结构与颜色。", 10)
		case "config":
			metadata["imageConfig"] = map[string]any{"providerId": "load-fake", "count": 3, "resolution": "1k", "outputFormat": "png"}
		}
		nodes = append(nodes, map[string]any{"id": fmt.Sprintf("node-%d", i), "type": kind, "title": "测试节点", "position": map[string]any{"x": i*80 + sequence, "y": i % 8 * 180}, "width": 256, "height": 256, "metadata": metadata})
		if i > 0 {
			connections = append(connections, map[string]any{"id": fmt.Sprintf("edge-%d", i), "fromNodeId": fmt.Sprintf("node-%d", i-1), "toNodeId": fmt.Sprintf("node-%d", i)})
		}
	}
	data, _ := json.Marshal(map[string]any{"nodes": nodes, "connections": connections, "maskResources": map[string]any{}, "backgroundMode": "lines", "showImageInfo": false, "viewport": map[string]any{"x": sequence, "y": sequence * 2, "k": 0.8}})
	return data
}

func workflowGraph(uid string) model.WorkflowGraph {
	g := model.WorkflowGraph{Version: 1, Nodes: []model.WorkflowNode{}, Connections: []model.WorkflowConnection{}}
	// 12 nodes; two branches with three outputs each join at the last step.
	for i := 0; i < 7; i++ {
		g.Nodes = append(g.Nodes, model.WorkflowNode{ID: fmt.Sprintf("text-%d", i), Type: model.WorkflowNodeTextInput, Text: "压测本地图像，禁止外部生成", Position: model.WorkflowPoint{X: float64(i * 100), Y: 100}})
	}
	for i := 0; i < 2; i++ {
		g.Nodes = append(g.Nodes, model.WorkflowNode{ID: fmt.Sprintf("image-%d", i), Type: model.WorkflowNodeImageInput, MediaID: fmt.Sprintf("%s-media-%03d", uid, i), Position: model.WorkflowPoint{X: float64(i * 100), Y: 300}})
	}
	for i := 0; i < 3; i++ {
		id := fmt.Sprintf("gen-%d", i)
		ports := []model.WorkflowInputPort{{ID: "text", Type: model.WorkflowPortText}, {ID: "image", Type: model.WorkflowPortImage}}
		slots := []model.WorkflowOutputSlot{{ID: "out-0", Type: model.WorkflowPortImage}}
		if i < 2 {
			slots = append(slots, model.WorkflowOutputSlot{ID: "out-1", Type: model.WorkflowPortImage}, model.WorkflowOutputSlot{ID: "out-2", Type: model.WorkflowPortImage})
		} else {
			ports = append(ports, model.WorkflowInputPort{ID: "image2", Type: model.WorkflowPortImage})
		}
		g.Nodes = append(g.Nodes, model.WorkflowNode{ID: id, Type: model.WorkflowNodeImageGeneration, InputPorts: ports, Outputs: slots, Config: &model.WorkflowNodeConfig{ProviderID: "load-fake", Size: "1024x1024", Resolution: "1k", OutputFormat: "png"}, Position: model.WorkflowPoint{X: 600, Y: float64(i * 300)}})
		g.Connections = append(g.Connections, model.WorkflowConnection{SourceNodeID: fmt.Sprintf("text-%d", i), SourceSlotID: "output", TargetNodeID: id, TargetPortID: "text", Order: 0})
		if i < 2 {
			g.Connections = append(g.Connections, model.WorkflowConnection{SourceNodeID: fmt.Sprintf("image-%d", i), SourceSlotID: "output", TargetNodeID: id, TargetPortID: "image", Order: 1})
		} else {
			g.Connections = append(g.Connections, model.WorkflowConnection{SourceNodeID: "gen-0", SourceSlotID: "out-0", TargetNodeID: id, TargetPortID: "image", Order: 1}, model.WorkflowConnection{SourceNodeID: "gen-1", SourceSlotID: "out-0", TargetNodeID: id, TargetPortID: "image2", Order: 2})
		}
	}
	return g
}

func seed(dir string, png []byte) ([]fixture, error) {
	db, err := repository.DB()
	if err != nil {
		return nil, err
	}
	users := []fixture{}
	for u := 0; u < 50; u++ {
		uid := fmt.Sprintf("load-user-%02d", u)
		if err := repository.UpsertPortalMembers([]model.PortalMember{{UserUID: uid, DisplayName: uid, Enabled: true, Roles: []string{}, SyncedAt: time.Now().UTC()}}); err != nil {
			return nil, err
		}
		folders := []model.PrivateFolder{}
		for j := 0; j < 5; j++ {
			folders = append(folders, model.PrivateFolder{ID: fmt.Sprintf("%s-folder-%d", uid, j), OwnerUID: uid, Title: fmt.Sprintf("文件夹%d", j), CreatedAt: time.Now().UTC().Format(time.RFC3339)})
		}
		if err := db.Create(&folders).Error; err != nil {
			return nil, err
		}
		media := []model.Media{}
		for j := 0; j < 200; j++ {
			id := fmt.Sprintf("%s-media-%03d", uid, j)
			key := id + ".png"
			// Only actual graph inputs need bytes; the rest exercise metadata queries.
			if j < 2 {
				if err := os.WriteFile(filepath.Join(dir, key), png, 0600); err != nil {
					return nil, err
				}
			}
			media = append(media, model.Media{ID: id, OwnerUID: uid, Source: model.MediaSourceUpload, ObjectKey: key, ContentType: "image/png", Width: 64, Height: 64, Bytes: int64(len(png)), Filename: key, Title: id, FolderID: folders[j%5].ID, CreatedAt: time.Now().UTC().Format(time.RFC3339), CleanupStatus: model.MediaCleanupActive})
		}
		if err := db.CreateInBatches(&media, 200).Error; err != nil {
			return nil, err
		}
		f := fixture{UID: uid}
		user := service.PortalUser{UID: uid, Username: uid}
		for _, n := range []int{30, 150, 250} {
			id := fmt.Sprintf("%s-canvas-%d", uid, n)
			_, err := service.CreateCanvasProject(context.Background(), user, service.CanvasProjectInput{ID: id, Title: "压测画布", Document: canvasDocument(uid, n, 0)})
			if err != nil {
				return nil, fmt.Errorf("seed canvas: %w", err)
			}
			f.CanvasIDs = append(f.CanvasIDs, id)
		}
		g := workflowGraph(uid)
		w, err := service.CreateWorkflow(context.Background(), user, service.WorkflowCreateInput{Name: "压测流程", Graph: &g})
		if err != nil {
			return nil, fmt.Errorf("seed workflow: %w", err)
		}
		f.WorkflowID = w.ID
		// Historical completed rows exercise run pagination/snapshot queries without startup queue bias.
		for j := 0; j < 10; j++ {
			id := fmt.Sprintf("%s-history-%d", uid, j)
			snapshot, _ := json.Marshal(g)
			completedAt := time.Now().UTC()
			run := model.WorkflowRun{ID: id, OwnerUID: uid, WorkflowID: w.ID, Revision: 1, Title: w.Name, Snapshot: string(snapshot), RequestID: id, Status: "completed", StateVersion: 1, CreatedAt: completedAt, UpdatedAt: completedAt, FinishedAt: &completedAt}
			outputs := []model.WorkflowOutputExecution{}
			steps := []model.WorkflowStepExecution{}
			for _, node := range g.Nodes {
				if len(node.Outputs) > 0 {
					steps = append(steps, model.WorkflowStepExecution{RunID: id, NodeID: node.ID, Status: "succeeded"})
				}
				for _, slot := range node.Outputs {
					outputs = append(outputs, model.WorkflowOutputExecution{RunID: id, NodeID: node.ID, SlotID: slot.ID, Status: "succeeded", Attempt: 1, MediaID: media[0].ID, UpdatedAt: time.Now().UTC()})
				}
			}
			if err := db.Transaction(func(tx *gorm.DB) error {
				if err := tx.Create(&run).Error; err != nil {
					return err
				}
				if len(steps) > 0 {
					if err := tx.Create(&steps).Error; err != nil {
						return err
					}
				}
				if len(outputs) > 0 {
					return tx.Create(&outputs).Error
				}
				return nil
			}); err != nil {
				return nil, err
			}
			f.RunID = id
		}
		users = append(users, f)
	}
	return users, nil
}
