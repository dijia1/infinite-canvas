package model

// PublicImage exposes one image media record to every authenticated Portal user.
// The underlying media object remains private in storage and is only made
// available through an application-issued short-lived URL.
type PublicImage struct {
	ID          string `json:"id" gorm:"primaryKey"`
	MediaID     string `json:"mediaId" gorm:"uniqueIndex"`
	FolderID    string `json:"folderId" gorm:"index"`
	Title       string `json:"title" gorm:"index"`
	UploaderUID string `json:"uploaderUid" gorm:"index"`
	CreatedAt   string `json:"createdAt"`
	Media       Media  `json:"-" gorm:"foreignKey:MediaID;references:ID"`
}

type PublicImageList struct {
	Items []PublicImage `json:"items"`
	Total int           `json:"total"`
}
