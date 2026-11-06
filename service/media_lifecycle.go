package service

import (
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"log"
)

func auditMediaFailure(item model.Media, actor, event, reason string) {
	if err := repository.RecordMediaLifecycleFailure(item, actor, event, reason); err != nil {
		log.Printf("media lifecycle audit failed media_id=%s event=%s: %v", item.ID, event, err)
	}
}

func auditMediaAccessFailure(item model.Media, actor string, err error) {
	if err == nil {
		return
	}
	reason := "access_failed"
	if message, ok := SafeMessage(err); ok {
		switch message {
		case "图片不存在", "公共图片不存在":
			reason = "record_missing"
		case "无权访问该图片":
			reason = "access_denied"
		}
	}
	auditMediaFailure(item, actor, "access_failed", reason)
}
