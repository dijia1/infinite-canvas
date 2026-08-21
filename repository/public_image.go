package repository

import (
	"errors"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
)

func SavePublicImage(item model.PublicImage) (model.PublicImage, error) {
	db, err := DB()
	if err != nil {
		return model.PublicImage{}, err
	}
	return item, db.Create(&item).Error
}

func GetPublicImage(id string) (model.PublicImage, bool, error) {
	db, err := DB()
	if err != nil {
		return model.PublicImage{}, false, err
	}
	item := model.PublicImage{}
	err = db.Preload("Media").First(&item, "id = ?", id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.PublicImage{}, false, nil
	}
	return item, err == nil, err
}

func ListPublicImages(q model.Query) ([]model.PublicImage, int64, error) {
	db, err := DB()
	if err != nil {
		return nil, 0, err
	}
	q.Normalize()
	tx := db.Model(&model.PublicImage{})
	if q.Keyword != "" {
		tx = tx.Where("title LIKE ?", "%"+q.Keyword+"%")
	}
	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	items := make([]model.PublicImage, 0)
	err = tx.Preload("Media").Order("created_at desc").Offset(q.Offset()).Limit(q.PageSize).Find(&items).Error
	return items, total, err
}

func DeletePublicImage(id string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Delete(&model.PublicImage{}, "id = ?", id).Error
}
