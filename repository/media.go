package repository

import (
	"errors"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
)

func SaveMedia(item model.Media) (model.Media, error) {
	db, err := DB()
	if err != nil {
		return model.Media{}, err
	}
	return item, db.Create(&item).Error
}

func GetMedia(id string) (model.Media, bool, error) {
	db, err := DB()
	if err != nil {
		return model.Media{}, false, err
	}
	item := model.Media{}
	err = db.First(&item, "id = ?", id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.Media{}, false, nil
	}
	return item, err == nil, err
}

func DeleteMedia(id string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Delete(&model.Media{}, "id = ?", id).Error
}
